package dev.jasonpearson.automobile.desktop.core.video

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure client-side quality controller: derives the live frame rate from the timestamps of decoded
 * frames and, when auto-adjustment is on, decides preset downgrades/upgrades with hysteresis and a
 * minimum dwell so a brief dip cannot thrash the encode. No Compose, no IO — frame timestamps are
 * the only clock, so every decision is deterministic.
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
  fun `derives actual fps from frame arrival timestamps`() {
    val controller = QualityController(initialQuality = VideoStreamQuality.Medium, targetFps = 30)
    // 20 frames, 50ms apart => a steady 20 fps.
    controller.feed(count = 20, intervalMs = 50)
    assertEquals(20f, controller.actualFps.value, 0.1f)
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
    // 10 fps (100ms apart) is a third of the 30fps target — chronic, so it keeps stepping down to
    // the cheapest preset while the drop lasts.
    controller.feed(count = 40, intervalMs = 100)
    assertEquals(VideoStreamQuality.Low, controller.quality.value)
  }

  @Test
  fun `does not downgrade a brief dip shorter than the hysteresis window`() {
    var changes = 0
    val controller =
      QualityController(
        initialQuality = VideoStreamQuality.High,
        targetFps = 30,
        samplesToDowngrade = 3,
        minDwellMs = 0,
        onQualityChange = { changes++ },
      )
    // Warm the rate up at a healthy 30fps first.
    var t = controller.feed(count = 15, intervalMs = 33)
    // A single slow frame (one 200ms gap) briefly perturbs the EMA but recovers immediately.
    controller.onFrame(t + 200)
    t += 233
    controller.feed(count = 15, intervalMs = 33, startMs = t)
    assertEquals(VideoStreamQuality.High, controller.quality.value)
    assertEquals(0, changes)
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
    low.feed(count = 30, intervalMs = 200) // 5fps, chronic drop
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
    // Sustained heavy drop over ~4s (< the 5s dwell): without dwell this would fall to Low, but
    // only
    // one step is allowed inside the window.
    controller.feed(count = 40, intervalMs = 100)
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
    controller.feed(count = 30, intervalMs = 100)
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
        onQualityChange = { selected.add(it) },
      )
    controller.selectQuality(VideoStreamQuality.Low)
    assertEquals(VideoStreamQuality.Low, controller.quality.value)
    assertEquals(listOf(VideoStreamQuality.Low), selected)
    // Re-selecting the same quality is a no-op (no duplicate notification / churn).
    controller.selectQuality(VideoStreamQuality.Low)
    assertEquals(listOf(VideoStreamQuality.Low), selected)
  }
}
