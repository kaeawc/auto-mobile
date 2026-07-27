package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.domain.ActiveTouchFeedback
import dev.jasonpearson.automobile.desktop.domain.TouchFeedbackMarker
import dev.jasonpearson.automobile.desktop.domain.TouchFeedbackModel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The pure transient touch-feedback model (issue #3352). All time is fed in, so the fade
 * transitions run with no timer — record, age partway, age out, cap, reset, the dispatch gate, and
 * the captured-geometry rendering — the same way the other `desktop-domain` policies are tested.
 */
class TouchFeedbackModelTest {

  private val duration = 600L
  private val w = 1080
  private val h = 2340

  private fun model() = TouchFeedbackModel(durationMs = duration)

  private fun TouchFeedbackModel.recordAt(x: Int, y: Int, nowMs: Long) =
    record(x = x, y = y, deviceWidth = w, deviceHeight = h, nowMs = nowMs)

  @Test
  fun `a freshly recorded pulse is active at full strength`() {
    val model = model()
    model.recordAt(x = 100, y = 200, nowMs = 1_000L)

    val active = model.active(1_000L)
    assertEquals(1, active.size)
    assertEquals(100, active[0].marker.x)
    assertEquals(200, active[0].marker.y)
    // progress 0 at the instant it was recorded -> the UI renders it at full alpha.
    assertEquals(0f, active[0].progress)
    assertTrue(model.hasActive(1_000L))
  }

  @Test
  fun `progress rises as the pulse ages but stays visible until the duration elapses`() {
    val model = model()
    model.recordAt(x = 10, y = 20, nowMs = 0L)

    // Halfway through: still visible, progress 0.5.
    assertEquals(0.5f, model.active(300L).single().progress)
    assertTrue(model.hasActive(300L))

    // Just before the end: still visible.
    assertTrue(model.hasActive(599L))
  }

  @Test
  fun `a pulse expires exactly at the duration boundary`() {
    val model = model()
    model.recordAt(x = 10, y = 20, nowMs = 0L)

    // progress >= 1 at the boundary means fully faded: not returned, not counted active.
    assertTrue(model.active(600L).isEmpty())
    assertFalse(model.hasActive(600L))
    assertTrue(model.active(10_000L).isEmpty())
  }

  @Test
  fun `multiple concurrent pulses are all reported`() {
    val model = model()
    model.recordAt(x = 1, y = 1, nowMs = 0L)
    model.recordAt(x = 2, y = 2, nowMs = 100L)

    val active = model.active(200L)
    assertEquals(2, active.size)
  }

  @Test
  fun `recording prunes fully faded pulses so the list does not accumulate`() {
    val model = model()
    model.recordAt(x = 1, y = 1, nowMs = 0L)
    // A new record long after the first has faded drops the dead one.
    model.recordAt(x = 2, y = 2, nowMs = 5_000L)

    val active = model.active(5_000L)
    assertEquals(1, active.size)
    assertEquals(2, active.single().marker.x)
  }

  @Test
  fun `the number of retained pulses is capped, dropping the oldest first`() {
    val model = model()
    // All recorded at the same instant so none fades; only the cap can bound them.
    repeat(TouchFeedbackModel.MAX_MARKERS + 3) { i -> model.recordAt(x = i, y = i, nowMs = 0L) }

    val active = model.active(0L)
    assertEquals(TouchFeedbackModel.MAX_MARKERS, active.size)
    // The three oldest (x = 0,1,2) were evicted; the newest survive.
    assertFalse(active.any { it.marker.x < 3 })
    assertTrue(active.any { it.marker.x == TouchFeedbackModel.MAX_MARKERS + 2 })
  }

  @Test
  fun `reset drops every pulse`() {
    val model = model()
    model.recordAt(x = 1, y = 1, nowMs = 0L)
    model.reset()

    assertTrue(model.active(0L).isEmpty())
    assertFalse(model.hasActive(0L))
  }

  @Test
  fun `a backwards clock step never makes a pulse negative or invisible`() {
    val model = model()
    model.recordAt(x = 1, y = 1, nowMs = 1_000L)

    // Clock stepped back below the record instant: clamp progress to 0, stay visible.
    val active = model.active(900L)
    assertEquals(0f, active.single().progress)
    assertTrue(model.hasActive(900L))
  }

  @Test
  fun `a non-positive duration disables feedback`() {
    val model = TouchFeedbackModel(durationMs = 0L)
    model.recordAt(x = 1, y = 1, nowMs = 0L)

    assertTrue(model.active(0L).isEmpty())
    assertFalse(model.hasActive(0L))
  }

  // --- Dispatch gate (issue #3352, finding A): a pulse must signal only a forwarded tap. ---

  @Test
  fun `recordIfForwarded records nothing when the tap was not forwarded`() {
    val model = model()
    model.recordIfForwarded(
      forwarded = false,
      x = 100,
      y = 200,
      deviceWidth = w,
      deviceHeight = h,
      nowMs = 0L,
    )

    assertTrue(model.active(0L).isEmpty())
    assertFalse(model.hasActive(0L))
  }

  @Test
  fun `recordIfForwarded records a pulse when the tap was forwarded`() {
    val model = model()
    model.recordIfForwarded(
      forwarded = true,
      x = 100,
      y = 200,
      deviceWidth = w,
      deviceHeight = h,
      nowMs = 0L,
    )

    assertEquals(1, model.active(0L).size)
  }

  // --- Captured geometry (issue #3352, finding B): the pulse renders through the snapshot bounds
  // it was captured with, not a later/live geometry. ---

  @Test
  fun `frameOffset scales through the marker's captured device width, not a live one`() {
    // A center tap captured against a 1080-wide snapshot.
    val marker =
      TouchFeedbackMarker(
        x = 540,
        y = 1170,
        deviceWidth = 1080,
        deviceHeight = 2340,
        startedAtMs = 0L,
      )
    val active = ActiveTouchFeedback(marker = marker, progress = 0f)

    // Rendered into a 540px-wide frame: exactly half device -> the frame center x.
    val offset = active.frameOffset(frameWidthPx = 540f)
    assertEquals(270f, offset.x)
    assertEquals(585f, offset.y)

    // The SAME device point captured against a different (e.g. post-resolution-change) snapshot
    // width lands at a DIFFERENT frame offset for the same frame — proving the captured width, not
    // a live dimension, drives placement.
    val staleWidthMarker = marker.copy(deviceWidth = 720)
    val staleOffset = ActiveTouchFeedback(staleWidthMarker, 0f).frameOffset(540f)
    assertEquals(405f, staleOffset.x)
  }

  @Test
  fun `frameOffset yields the origin for a degenerate zero-width snapshot`() {
    val marker =
      TouchFeedbackMarker(x = 5, y = 9, deviceWidth = 0, deviceHeight = 0, startedAtMs = 0L)
    val offset = ActiveTouchFeedback(marker, 0f).frameOffset(540f)
    assertEquals(0f, offset.x)
    assertEquals(0f, offset.y)
  }
}
