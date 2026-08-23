package dev.jasonpearson.automobile.desktop.core.video

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure client-side quality controller: derives the live frame rate from the timestamps of decoded
 * frames and, when auto-adjustment is on, decides preset downgrades/upgrades with hysteresis and a
 * minimum dwell. Frame timestamps are the only clock, so every decision is deterministic. Drops are
 * detected by inter-frame interval band — the target is 30fps (33ms), the active-but-slow "drop"
 * band is intervals of ~42–90ms, and intervals at/over 90ms are treated as idle (a static screen's
 * repeat cadence or a suppression/reconnect gap), never as degradation.
 */
class QualityControllerTest {

  /**
   * Feeds [count] frames spaced [intervalMs] apart starting at [startMs]; returns the next time.
   */
  private fun QualityController.feed(count: Int, intervalMs: Long, startMs: Long = 0L): Long {
    var t = startMs
    repeat(count) {
      onFrame(t)
      t += intervalMs
    }
    return t
  }

  @Test
  fun `derives actual fps as frames over elapsed`() {
    val controller = QualityController(initialQuality = VideoStreamQuality.Medium, targetFps = 30)
    // 20 frames, 50ms apart => a steady 20 fps.
    controller.feed(count = 20, intervalMs = 50)
    assertEquals(20f, controller.actualFps.value, 0.2f)
  }

  @Test
  fun `measures fps by frames over elapsed, not an average of instantaneous rates`() {
    // Alternating 10ms / 90ms gaps are two frames per 100ms = 20fps. An average of instantaneous
    // 1000/dt values would overstate this to ~50fps; frames-over-elapsed reports the true rate.
    val controller = QualityController(initialQuality = VideoStreamQuality.High, targetFps = 30)
    var t = 0L
    repeat(40) { i ->
      controller.onFrame(t)
      t += if (i % 2 == 0) 10L else 90L
    }
    assertEquals(20f, controller.actualFps.value, 2f)
  }

  @Test
  fun `reports zero fps before two frames arrive`() {
    val controller = QualityController(initialQuality = VideoStreamQuality.Medium, targetFps = 30)
    assertEquals(0f, controller.actualFps.value, 0.0f)
    controller.onFrame(0)
    assertEquals(0f, controller.actualFps.value, 0.0f)
  }

  @Test
  fun `cascades down while a heavy drop persists`() {
    val controller =
      QualityController(
        initialQuality = VideoStreamQuality.High,
        targetFps = 30,
        samplesToDowngrade = 3,
        minDwellMs = 0,
      )
    // ~17fps (60ms apart) is well under the 30fps target but faster than the idle cadence, so it is
    // read as genuine degradation and keeps stepping down to the cheapest preset.
    controller.feed(count = 60, intervalMs = 60)
    assertEquals(VideoStreamQuality.Low, controller.quality.value)
  }

  @Test
  fun `a static screen at the idle-repeat cadence does not downgrade`() {
    // Android repeats the previous frame after ~100ms on a still screen, so a static screen streams
    // at ~10fps. That is not encoder/transport degradation and must not ratchet the preset down.
    val controller =
      QualityController(
        initialQuality = VideoStreamQuality.High,
        targetFps = 30,
        samplesToDowngrade = 3,
        minDwellMs = 0,
      )
    controller.feed(count = 60, intervalMs = 100)
    assertEquals(VideoStreamQuality.High, controller.quality.value)
  }

  @Test
  fun `does not downgrade a brief dip shorter than the hysteresis window`() {
    val controller =
      QualityController(
        initialQuality = VideoStreamQuality.High,
        targetFps = 30,
        samplesToDowngrade = 3,
        minDwellMs = 0,
      )
    // Warm the rate up at a healthy 30fps first.
    var t = controller.feed(count = 15, intervalMs = 33)
    // A single slow frame (one 200ms gap) is idle-consistent and clears the streak; it recovers.
    controller.onFrame(t + 200)
    t += 233
    controller.feed(count = 15, intervalMs = 33, startMs = t)
    assertEquals(VideoStreamQuality.High, controller.quality.value)
  }

  @Test
  fun `climbs back up once the rate is sustainably healthy`() {
    val controller =
      QualityController(
        initialQuality = VideoStreamQuality.Low,
        targetFps = 30,
        samplesToUpgrade = 8,
        minDwellMs = 0,
      )
    // Steady 30fps (33ms apart) is at target — healthy enough to climb to the top preset.
    controller.feed(count = 60, intervalMs = 33)
    assertEquals(VideoStreamQuality.High, controller.quality.value)
  }

  @Test
  fun `never downgrades below Low or upgrades above High`() {
    val low =
      QualityController(
        initialQuality = VideoStreamQuality.Low,
        targetFps = 30,
        samplesToDowngrade = 3,
        minDwellMs = 0,
      )
    low.feed(count = 30, intervalMs = 60) // ~17fps, chronic drop
    assertEquals(VideoStreamQuality.Low, low.quality.value)

    val high =
      QualityController(
        initialQuality = VideoStreamQuality.High,
        targetFps = 30,
        samplesToUpgrade = 5,
        minDwellMs = 0,
      )
    high.feed(count = 30, intervalMs = 33) // perfect rate
    assertEquals(VideoStreamQuality.High, high.quality.value)
  }

  @Test
  fun `min dwell paces automatic changes to one step per window`() {
    val controller =
      QualityController(
        initialQuality = VideoStreamQuality.High,
        targetFps = 30,
        samplesToDowngrade = 3,
        minDwellMs = 5_000,
      )
    // Sustained drop over ~3.6s (< the 5s dwell): without dwell this would fall to Low, but only
    // one
    // step is allowed inside the window.
    controller.feed(count = 60, intervalMs = 60)
    assertEquals(VideoStreamQuality.Medium, controller.quality.value)
  }

  @Test
  fun `auto adjustment can be disabled while fps is still measured`() {
    val controller =
      QualityController(
        initialQuality = VideoStreamQuality.High,
        targetFps = 30,
        samplesToDowngrade = 3,
        minDwellMs = 0,
        autoAdjustEnabled = false,
      )
    controller.feed(count = 30, intervalMs = 60)
    assertEquals(VideoStreamQuality.High, controller.quality.value)
    assertTrue("fps still measured when auto-adjust off", controller.actualFps.value > 0f)
  }

  @Test
  fun `manual selection overrides quality and notifies`() {
    val selected = mutableListOf<VideoStreamQuality>()
    val controller =
      QualityController(
        initialQuality = VideoStreamQuality.Medium,
        targetFps = 30,
        onManualSelection = { selected.add(it) },
      )
    controller.selectQuality(VideoStreamQuality.Low)
    assertEquals(VideoStreamQuality.Low, controller.quality.value)
    assertEquals(listOf(VideoStreamQuality.Low), selected)
    // Re-selecting the same quality is a no-op (no duplicate notification / churn).
    controller.selectQuality(VideoStreamQuality.Low)
    assertEquals(listOf(VideoStreamQuality.Low), selected)
  }

  @Test
  fun `automatic changes update quality but are not persisted`() {
    val selected = mutableListOf<VideoStreamQuality>()
    val controller =
      QualityController(
        initialQuality = VideoStreamQuality.High,
        targetFps = 30,
        samplesToDowngrade = 3,
        minDwellMs = 0,
        onManualSelection = { selected.add(it) },
      )
    controller.feed(count = 60, intervalMs = 60) // heavy drop → auto-downgrades
    assertEquals(VideoStreamQuality.Low, controller.quality.value)
    // Automatic steps re-subscribe via `quality` but must not fire the persistence callback.
    assertEquals(emptyList<VideoStreamQuality>(), selected)
  }

  @Test
  fun `a reconnect gap right after a change does not immediately downgrade`() {
    val controller =
      QualityController(
        initialQuality = VideoStreamQuality.Medium,
        targetFps = 30,
        // Aggressive: a single dropping sample would downgrade if the gap were counted.
        samplesToDowngrade = 1,
        minSamplesForDecision = 1,
        minDwellMs = 0,
      )
    controller.selectQuality(VideoStreamQuality.High) // triggers a re-subscribe
    // The first frame after the reconnect arrives a long time later; the reset window swallows it
    // as
    // the new seed rather than treating the whole gap as one drop sample.
    controller.onFrame(10_000)
    assertEquals(VideoStreamQuality.High, controller.quality.value)
  }
}
