package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Fast, Android-free tests for the shared gesture dispatch perf/result lifecycle introduced for
 * issue #2817. The AccessibilityService callback wiring stays in [CtrlProxy], while this helper
 * pins the branch behavior that used to be hand-copied across five gesture methods.
 */
class GestureDispatchLifecycleTest {

  @Test
  fun `completed result includes gesture timing and closes perf in order`() {
    val events = mutableListOf<String>()
    val clock = MutableClock(100L)
    val lifecycle = createLifecycle(events, clock)
    val outcomes = mutableListOf<GestureDispatchOutcome>()

    lifecycle.startDispatch()
    clock.now = 180L
    lifecycle.completed { outcome ->
      events.add("result:${outcome.completed}")
      outcomes.add(outcome)
    }

    assertEquals(
      listOf("start:dispatchGesture", "endOperation:dispatchGesture", "end", "result:true"),
      events,
    )
    assertEquals(
      GestureDispatchOutcome(
        completed = true,
        totalTimeMs = 80L,
        gestureTimeMs = 30L,
        error = null,
      ),
      outcomes.single(),
    )
  }

  @Test
  fun `cancelled result reports cancellation and closes perf`() {
    val events = mutableListOf<String>()
    val clock = MutableClock(200L)
    val lifecycle = createLifecycle(events, clock)
    val outcomes = mutableListOf<GestureDispatchOutcome>()

    lifecycle.startDispatch()
    clock.now = 260L
    lifecycle.cancelled { outcomes.add(it) }

    assertEquals(listOf("start:dispatchGesture", "endOperation:dispatchGesture", "end"), events)
    assertEquals(false, outcomes.single().completed)
    assertEquals(60L, outcomes.single().totalTimeMs)
    assertNull(outcomes.single().gestureTimeMs)
    assertEquals("Gesture was cancelled", outcomes.single().error)
  }

  @Test
  fun `completed result captures time after pre-result work`() {
    val events = mutableListOf<String>()
    val clock = MutableClock(100L)
    val lifecycle = createLifecycle(events, clock)
    val outcomes = mutableListOf<GestureDispatchOutcome>()

    lifecycle.startDispatch()
    clock.now = 180L
    lifecycle.completed(
      beforeResult = {
        events.add("beforeResult")
        clock.now = 210L
      },
      onResult = { outcomes.add(it) },
    )

    assertEquals(
      listOf("start:dispatchGesture", "endOperation:dispatchGesture", "beforeResult", "end"),
      events,
    )
    assertEquals(110L, outcomes.single().totalTimeMs)
    assertEquals(60L, outcomes.single().gestureTimeMs)
  }

  @Test
  fun `not dispatched result reports dispatch failure and closes perf`() {
    val events = mutableListOf<String>()
    val clock = MutableClock(300L)
    val lifecycle = createLifecycle(events, clock)
    val outcomes = mutableListOf<GestureDispatchOutcome>()

    lifecycle.startDispatch()
    clock.now = 315L
    lifecycle.notDispatched { outcomes.add(it) }

    assertEquals(listOf("start:dispatchGesture", "endOperation:dispatchGesture", "end"), events)
    assertEquals(false, outcomes.single().completed)
    assertEquals(15L, outcomes.single().totalTimeMs)
    assertEquals("Failed to dispatch gesture", outcomes.single().error)
  }

  @Test
  fun `exception result reports exception message and closes perf`() {
    val events = mutableListOf<String>()
    val clock = MutableClock(400L)
    val lifecycle = createLifecycle(events, clock)
    val outcomes = mutableListOf<GestureDispatchOutcome>()

    lifecycle.startDispatch()
    clock.now = 425L
    lifecycle.failed(IllegalStateException("dispatch exploded")) { outcomes.add(it) }

    assertEquals(listOf("start:dispatchGesture", "endOperation:dispatchGesture", "end"), events)
    assertFalse(outcomes.single().completed)
    assertEquals(25L, outcomes.single().totalTimeMs)
    assertNull(outcomes.single().gestureTimeMs)
    assertEquals("dispatch exploded", outcomes.single().error)
  }

  @Test
  fun `result exception still closes root perf block`() {
    val events = mutableListOf<String>()
    val lifecycle = createLifecycle(events, MutableClock(500L))

    lifecycle.startDispatch()
    val thrown =
      assertThrows(RuntimeException::class.java) {
        lifecycle.completed { throw RuntimeException("result failed") }
      }

    assertEquals("result failed", thrown.message)
    assertEquals(listOf("start:dispatchGesture", "endOperation:dispatchGesture", "end"), events)
  }

  private fun createLifecycle(
    events: MutableList<String>,
    clock: MutableClock,
  ): GestureDispatchLifecycle =
    GestureDispatchLifecycle(
      startTimeMs = clock.now,
      gestureBuiltTimeMs = clock.now + 50L,
      nowMs = { clock.now },
      startOperation = { events.add("start:$it") },
      endOperation = { events.add("endOperation:$it") },
      endPerfBlock = { events.add("end") },
    )

  private class MutableClock(var now: Long)
}
