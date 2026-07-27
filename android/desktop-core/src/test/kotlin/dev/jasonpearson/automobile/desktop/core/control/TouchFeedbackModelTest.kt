package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.domain.TouchFeedbackModel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The pure transient touch-feedback model (issue #3352). All time is fed in, so the fade
 * transitions run with no timer — record, age partway, age out, cap, and reset — the same way the
 * other `desktop-domain` policies are tested.
 */
class TouchFeedbackModelTest {

  private val duration = 600L

  private fun model() = TouchFeedbackModel(durationMs = duration)

  @Test
  fun `a freshly recorded pulse is active at full strength`() {
    val model = model()
    model.record(x = 100, y = 200, nowMs = 1_000L)

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
    model.record(x = 10, y = 20, nowMs = 0L)

    // Halfway through: still visible, progress 0.5.
    assertEquals(0.5f, model.active(300L).single().progress)
    assertTrue(model.hasActive(300L))

    // Just before the end: still visible.
    assertTrue(model.hasActive(599L))
  }

  @Test
  fun `a pulse expires exactly at the duration boundary`() {
    val model = model()
    model.record(x = 10, y = 20, nowMs = 0L)

    // progress >= 1 at the boundary means fully faded: not returned, not counted active.
    assertTrue(model.active(600L).isEmpty())
    assertFalse(model.hasActive(600L))
    assertTrue(model.active(10_000L).isEmpty())
  }

  @Test
  fun `multiple concurrent pulses are all reported`() {
    val model = model()
    model.record(x = 1, y = 1, nowMs = 0L)
    model.record(x = 2, y = 2, nowMs = 100L)

    val active = model.active(200L)
    assertEquals(2, active.size)
  }

  @Test
  fun `recording prunes fully faded pulses so the list does not accumulate`() {
    val model = model()
    model.record(x = 1, y = 1, nowMs = 0L)
    // A new record long after the first has faded drops the dead one.
    model.record(x = 2, y = 2, nowMs = 5_000L)

    val active = model.active(5_000L)
    assertEquals(1, active.size)
    assertEquals(2, active.single().marker.x)
  }

  @Test
  fun `the number of retained pulses is capped, dropping the oldest first`() {
    val model = model()
    // All recorded at the same instant so none fades; only the cap can bound them.
    repeat(TouchFeedbackModel.MAX_MARKERS + 3) { i -> model.record(x = i, y = i, nowMs = 0L) }

    val active = model.active(0L)
    assertEquals(TouchFeedbackModel.MAX_MARKERS, active.size)
    // The three oldest (x = 0,1,2) were evicted; the newest survive.
    assertFalse(active.any { it.marker.x < 3 })
    assertTrue(active.any { it.marker.x == TouchFeedbackModel.MAX_MARKERS + 2 })
  }

  @Test
  fun `reset drops every pulse`() {
    val model = model()
    model.record(x = 1, y = 1, nowMs = 0L)
    model.reset()

    assertTrue(model.active(0L).isEmpty())
    assertFalse(model.hasActive(0L))
  }

  @Test
  fun `a backwards clock step never makes a pulse negative or invisible`() {
    val model = model()
    model.record(x = 1, y = 1, nowMs = 1_000L)

    // Clock stepped back below the record instant: clamp progress to 0, stay visible.
    val active = model.active(900L)
    assertEquals(0f, active.single().progress)
    assertTrue(model.hasActive(900L))
  }

  @Test
  fun `a non-positive duration disables feedback`() {
    val model = TouchFeedbackModel(durationMs = 0L)
    model.record(x = 1, y = 1, nowMs = 0L)

    assertTrue(model.active(0L).isEmpty())
    assertFalse(model.hasActive(0L))
  }
}
