package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.domain.ActiveTouchFeedback
import dev.jasonpearson.automobile.desktop.domain.TouchFeedbackMarker
import dev.jasonpearson.automobile.desktop.domain.TouchFeedbackModel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The pure transient touch-feedback model (issue #3352). The clock is injected — a mutable
 * monotonic fake — so the fade transitions run with no timer: record, age partway, age out, cap,
 * reset, the dispatch gate, monotonic aging, and the captured-geometry rendering, the same way the
 * other `desktop-domain` policies are tested. Aging reads the injected clock, so a model that read
 * a real clock instead would leave a pulse un-aged under the fed clock (see the monotonic test).
 */
class TouchFeedbackModelTest {

  private val duration = 600L
  private val w = 1080
  private val h = 2340

  /** A controllable monotonic clock: the test advances [now] and the model reads it. */
  private var now = 0L

  private fun model() = TouchFeedbackModel(durationMs = duration, nowMs = { now })

  private fun TouchFeedbackModel.recordAt(x: Int, y: Int, atMs: Long) {
    now = atMs
    record(x = x, y = y, deviceWidth = w, deviceHeight = h)
  }

  @Test
  fun `a freshly recorded pulse is active at full strength`() {
    val model = model()
    model.recordAt(x = 100, y = 200, atMs = 1_000L)

    val active = model.active()
    assertEquals(1, active.size)
    assertEquals(100, active[0].marker.x)
    assertEquals(200, active[0].marker.y)
    // progress 0 at the instant it was recorded -> the UI renders it at full alpha.
    assertEquals(0f, active[0].progress)
    assertTrue(model.hasActive())
  }

  @Test
  fun `progress rises as the pulse ages but stays visible until the duration elapses`() {
    val model = model()
    model.recordAt(x = 10, y = 20, atMs = 0L)

    // Halfway through: still visible, progress 0.5.
    now = 300L
    assertEquals(0.5f, model.active().single().progress)
    assertTrue(model.hasActive())

    // Just before the end: still visible.
    now = 599L
    assertTrue(model.hasActive())
  }

  @Test
  fun `a pulse expires exactly at the duration boundary`() {
    val model = model()
    model.recordAt(x = 10, y = 20, atMs = 0L)

    // progress >= 1 at the boundary means fully faded: not returned, not counted active.
    now = 600L
    assertTrue(model.active().isEmpty())
    assertFalse(model.hasActive())
    now = 10_000L
    assertTrue(model.active().isEmpty())
  }

  @Test
  fun `a pulse ages and expires on the injected monotonic clock`() {
    // Guards the wall-clock defect: the model MUST age against its injected clock, not a real one.
    // Recorded at t=0; advancing the injected clock past the duration must expire it. A model that
    // read System.currentTimeMillis() instead would see ~0 elapsed here and leave the pulse active.
    val model = model()
    model.recordAt(x = 1, y = 1, atMs = 0L)

    now = 100L
    assertTrue(model.hasActive())

    now = duration + 1L
    assertTrue(model.active().isEmpty())
    assertFalse(model.hasActive())
  }

  @Test
  fun `multiple concurrent pulses are all reported`() {
    val model = model()
    model.recordAt(x = 1, y = 1, atMs = 0L)
    model.recordAt(x = 2, y = 2, atMs = 100L)

    now = 200L
    val active = model.active()
    assertEquals(2, active.size)
  }

  @Test
  fun `recording prunes fully faded pulses so the list does not accumulate`() {
    val model = model()
    model.recordAt(x = 1, y = 1, atMs = 0L)
    // A new record long after the first has faded drops the dead one.
    model.recordAt(x = 2, y = 2, atMs = 5_000L)

    now = 5_000L
    val active = model.active()
    assertEquals(1, active.size)
    assertEquals(2, active.single().marker.x)
  }

  @Test
  fun `the number of retained pulses is capped, dropping the oldest first`() {
    val model = model()
    // All recorded at the same instant so none fades; only the cap can bound them.
    now = 0L
    repeat(TouchFeedbackModel.MAX_MARKERS + 3) { i ->
      record(model = model, x = i, y = i)
    }

    val active = model.active()
    assertEquals(TouchFeedbackModel.MAX_MARKERS, active.size)
    // The three oldest (x = 0,1,2) were evicted; the newest survive.
    assertFalse(active.any { it.marker.x < 3 })
    assertTrue(active.any { it.marker.x == TouchFeedbackModel.MAX_MARKERS + 2 })
  }

  private fun record(model: TouchFeedbackModel, x: Int, y: Int) =
    model.record(x = x, y = y, deviceWidth = w, deviceHeight = h)

  @Test
  fun `reset drops every pulse`() {
    val model = model()
    model.recordAt(x = 1, y = 1, atMs = 0L)
    model.reset()

    assertTrue(model.active().isEmpty())
    assertFalse(model.hasActive())
  }

  @Test
  fun `a non-monotonic clock reading below the record instant clamps to full strength, never negative`() {
    // Monotonic time never regresses, so this only exercises the defensive clamp: a clock reading
    // below a marker's record instant must keep the pulse at progress 0, not go negative/invisible.
    val model = model()
    model.recordAt(x = 1, y = 1, atMs = 1_000L)

    now = 900L
    val active = model.active()
    assertEquals(0f, active.single().progress)
    assertTrue(model.hasActive())
  }

  @Test
  fun `a non-positive duration disables feedback`() {
    val disabled = TouchFeedbackModel(durationMs = 0L, nowMs = { now })
    now = 0L
    disabled.record(x = 1, y = 1, deviceWidth = w, deviceHeight = h)

    assertTrue(disabled.active().isEmpty())
    assertFalse(disabled.hasActive())
  }

  // --- Dispatch gate (issue #3352, finding A): a pulse must signal only a forwarded tap. ---

  @Test
  fun `recordIfForwarded records nothing when the tap was not forwarded`() {
    val model = model()
    now = 0L
    model.recordIfForwarded(forwarded = false, x = 100, y = 200, deviceWidth = w, deviceHeight = h)

    assertTrue(model.active().isEmpty())
    assertFalse(model.hasActive())
  }

  @Test
  fun `recordIfForwarded records a pulse when the tap was forwarded`() {
    val model = model()
    now = 0L
    model.recordIfForwarded(forwarded = true, x = 100, y = 200, deviceWidth = w, deviceHeight = h)

    assertEquals(1, model.active().size)
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

  // --- Orientation (issue #3352): a rotation mid-pulse drops stale-oriented markers. ---

  @Test
  fun `retainOnlyOrientation drops pulses after a portrait to landscape flip`() {
    val model = model()
    now = 0L
    // Captured in portrait (w < h).
    model.record(x = 540, y = 1170, deviceWidth = 1080, deviceHeight = 2340)
    assertEquals(1, model.active().size)

    // Device rotates to landscape (w > h): the portrait marker no longer maps into the frame.
    model.retainOnlyOrientation(deviceWidth = 2340, deviceHeight = 1080)
    assertTrue(model.active().isEmpty())
  }

  @Test
  fun `retainOnlyOrientation keeps pulses on a same-orientation resolution change`() {
    val model = model()
    now = 0L
    // Captured in portrait 1080x2340.
    model.record(x = 540, y = 1170, deviceWidth = 1080, deviceHeight = 2340)

    // A same-orientation resolution change (still portrait) must NOT drop the pulse — the captured
    // bounds already place it correctly.
    model.retainOnlyOrientation(deviceWidth = 720, deviceHeight = 1560)
    assertEquals(1, model.active().size)
  }
}
