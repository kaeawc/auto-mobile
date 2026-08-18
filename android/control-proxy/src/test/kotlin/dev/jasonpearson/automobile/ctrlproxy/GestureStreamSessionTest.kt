package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Android-free continuation driver. Proves the pump loop chains the (already unit-tested)
 * coordinator's segments through the stroke dispatcher — one fresh initial stroke, the rest
 * continuations — and finishes exactly once, on both the lift and the dispatch-failure path.
 */
class GestureStreamSessionTest {

  private class FakeStroke(val segment: GestureSegment)

  private class FakeStrokeDispatcher : StrokeDispatcher<FakeStroke> {
    val dispatched = mutableListOf<GestureSegment>()
    var initialCount = 0
    var continueCount = 0
    private var pendingComplete: (() -> Unit)? = null
    private var pendingFail: ((String) -> Unit)? = null

    override fun initialStroke(segment: GestureSegment): FakeStroke {
      initialCount++
      return FakeStroke(segment)
    }

    override fun continueStroke(previous: FakeStroke, segment: GestureSegment): FakeStroke {
      continueCount++
      return FakeStroke(segment)
    }

    override fun dispatch(
      stroke: FakeStroke,
      onComplete: () -> Unit,
      onFailed: (error: String) -> Unit,
    ) {
      dispatched.add(stroke.segment)
      pendingComplete = onComplete
      pendingFail = onFailed
    }

    /** Fire the in-flight stroke's completion, driving the loop one step. */
    fun completeLast() {
      val c = requireNotNull(pendingComplete) { "no stroke in flight" }
      pendingComplete = null
      pendingFail = null
      c()
    }

    fun failLast(error: String) {
      val f = requireNotNull(pendingFail) { "no stroke in flight" }
      pendingComplete = null
      pendingFail = null
      f(error)
    }
  }

  private class Session(val dispatcher: FakeStrokeDispatcher = FakeStrokeDispatcher()) {
    var finishedSuccess: Boolean? = null
    var finishedError: String? = null
    var finishCount = 0
    val session =
      GestureStreamSession(
        coordinator = GestureStreamCoordinator(),
        dispatcher = dispatcher,
        runOnGestureThread = { it() }, // immediate: dispatch stores the callback, so no recursion
        onFinished = { success, error ->
          finishCount++
          finishedSuccess = success
          finishedError = error
        },
      )
  }

  @Test
  fun `start then end chains an initial press and a single lifting continuation`() {
    val h = Session()
    h.session.start(100f, 100f)

    // The first dispatched stroke is the fresh initial press.
    assertEquals(1, h.dispatcher.initialCount)
    assertTrue(h.dispatcher.dispatched[0].isInitial)

    h.session.end(100f, 200f, cancel = false)
    h.dispatcher.completeLast() // press done -> pump the lift

    val lift = h.dispatcher.dispatched[1]
    assertFalse("the lift is a continuation, not a fresh stroke", lift.isInitial)
    assertFalse("the lift stroke ends the gesture", lift.willContinue)
    assertEquals(1, h.dispatcher.continueCount)

    h.dispatcher.completeLast() // lift done -> coordinator reports Done
    assertEquals(1, h.finishCount)
    assertEquals(true, h.finishedSuccess)
    assertNull(h.finishedError)
  }

  @Test
  fun `a move chains a continuing stroke to the new point before the lift`() {
    val h = Session()
    h.session.start(0f, 0f)
    h.session.move(0f, 50f)
    h.dispatcher.completeLast() // press done -> pump the move

    val move = h.dispatcher.dispatched[1]
    assertEquals(GesturePoint(0f, 50f), move.to)
    assertTrue("mid-drag strokes keep the touch down", move.willContinue)

    h.session.end(0f, 60f, cancel = false)
    h.dispatcher.completeLast() // move done -> pump the lift
    val lift = h.dispatcher.dispatched.last()
    assertEquals(GesturePoint(0f, 60f), lift.to)
    assertFalse(lift.willContinue)

    h.dispatcher.completeLast() // lift done -> Done
    assertEquals(true, h.finishedSuccess)
  }

  @Test
  fun `an idle session parks after the press and resumes on the next move`() {
    val h = Session()
    h.session.start(5f, 5f)
    assertEquals(1, h.dispatcher.dispatched.size) // the press

    // Press completes with nothing buffered: the session parks (Wait) and dispatches NOTHING —
    // no cancel-inducing keep-alive stroke, no lift.
    h.dispatcher.completeLast()
    assertEquals("no stroke dispatched while idle", 1, h.dispatcher.dispatched.size)
    assertNull("still dragging, not finished", h.finishedSuccess)

    // A move arriving while parked resumes the loop and dispatches the continuation.
    h.session.move(5f, 200f)
    assertEquals(2, h.dispatcher.dispatched.size)
    assertEquals(GesturePoint(5f, 200f), h.dispatcher.dispatched[1].to)
    assertTrue(h.dispatcher.dispatched[1].willContinue)
  }

  @Test
  fun `a dispatch failure finishes the session once with the error`() {
    val h = Session()
    h.session.start(10f, 10f)

    h.dispatcher.failLast("dispatchGesture refused")

    assertEquals(1, h.finishCount)
    assertEquals(false, h.finishedSuccess)
    assertEquals("dispatchGesture refused", h.finishedError)
  }

  @Test
  fun `the registry routes by gesture id and drops on removal`() {
    val registry = GestureStreamRegistry()
    val h = Session()

    assertFalse(registry.contains("g1"))
    registry.register("g1", h.session)
    assertTrue(registry.contains("g1"))
    assertEquals(h.session, registry.get("g1"))
    assertEquals(listOf("g1"), registry.activeIds())

    assertEquals(h.session, registry.remove("g1"))
    assertFalse(registry.contains("g1"))
    assertNull(registry.get("g1"))
    assertTrue(registry.activeIds().isEmpty())
  }
}
