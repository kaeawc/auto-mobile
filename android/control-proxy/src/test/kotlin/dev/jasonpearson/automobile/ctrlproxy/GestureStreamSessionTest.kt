package dev.jasonpearson.automobile.ctrlproxy

import java.util.ArrayDeque
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

  private data class Ack(val requestId: String?, val success: Boolean, val error: String?)

  private class RouterHarness {
    private val gestureQueue = ArrayDeque<() -> Unit>()
    var acceptPosts = true
    val dispatchers = mutableListOf<FakeStrokeDispatcher>()
    val acks = mutableListOf<Ack>()
    val router =
      GestureStreamRouter(
        runOnGestureThread = {
          if (acceptPosts) gestureQueue.addLast(it)
          acceptPosts
        },
        newSession = { onFinished ->
          val dispatcher = FakeStrokeDispatcher()
          dispatchers.add(dispatcher)
          GestureStreamSession(
            coordinator = GestureStreamCoordinator(),
            dispatcher = dispatcher,
            runOnGestureThread = { gestureQueue.addLast(it) },
            onFinished = onFinished,
          )
        },
        onResult = { requestId, success, error -> acks.add(Ack(requestId, success, error)) },
      )

    fun drain() {
      while (gestureQueue.isNotEmpty()) gestureQueue.removeFirst()()
    }

    fun pendingEndCount(): Int {
      var count = -1
      router.pendingEndCount { count = it }
      drain()
      return count
    }

    fun terminalFailureCount(): Int {
      var count = -1
      router.terminalFailureCount { count = it }
      drain()
      return count
    }
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
  fun `end queued before a failure gets the actual result exactly once`() {
    val h = RouterHarness()
    h.router.start("start", "g1", 1f, 2f)
    h.drain()
    assertEquals(listOf(Ack("start", true, null)), h.acks)

    // The end was received on IO, but its routing work has not run yet. The gesture callback
    // finishes first on the gesture thread; the queued end must consume that result.
    h.router.end("end", "g1", 3f, 4f, cancel = false)
    h.dispatchers.single().failLast("dispatch cancelled")
    h.drain()

    assertEquals(
      listOf(Ack("end", false, "dispatch cancelled")),
      h.acks.filter { it.requestId == "end" },
    )
    assertEquals(0, h.pendingEndCount())
    assertEquals(0, h.terminalFailureCount())
  }

  @Test
  fun `end strictly after a finished session receives its failure`() {
    val h = RouterHarness()
    h.router.start("start", "g1", 1f, 2f)
    h.drain()
    h.dispatchers.single().failLast("framework cancelled")
    h.router.end("end", "g1", 3f, 4f, cancel = false)
    h.router.end("late-end", "g1", 3f, 4f, cancel = false)
    h.drain()

    assertEquals(
      listOf(
        Ack("start", true, null),
        Ack("end", false, "framework cancelled"),
        Ack("late-end", true, null),
      ),
      h.acks,
    )
    assertEquals(0, h.pendingEndCount())
    assertEquals(0, h.terminalFailureCount())
  }

  @Test
  fun `unclaimed failures evict the oldest after sixteen entries`() {
    val h = RouterHarness()
    repeat(17) { index ->
      h.router.start("start-$index", "g$index", 1f, 2f)
      h.drain()
      h.dispatchers.last().failLast("failure $index")
    }
    assertEquals(16, h.terminalFailureCount())

    h.router.end("evicted", "g0", 3f, 4f, cancel = false)
    h.router.end("recent", "g16", 3f, 4f, cancel = false)
    h.drain()

    assertEquals(Ack("evicted", true, null), h.acks.last { it.requestId == "evicted" })
    assertEquals(Ack("recent", false, "failure 16"), h.acks.last { it.requestId == "recent" })
    assertEquals(15, h.terminalFailureCount())
  }

  @Test
  fun `end registered before a failure receives one correlated failure`() {
    val h = RouterHarness()
    h.router.start("start", "g1", 1f, 2f)
    h.drain()
    h.router.end("end", "g1", 3f, 4f, cancel = false)
    h.drain()
    assertEquals(1, h.pendingEndCount())

    h.dispatchers.single().failLast("lift cancelled")

    assertEquals(listOf(Ack("start", true, null), Ack("end", false, "lift cancelled")), h.acks)
    assertEquals(0, h.pendingEndCount())
  }

  @Test
  fun `queued start and ends give each waiter one result and leave no pending ids`() {
    val h = RouterHarness()
    // Simulate WebSocket calls from two producers before the gesture thread drains its queue.
    h.router.start("start", "g1", 1f, 2f)
    h.router.start("duplicate", "g1", 1f, 2f)
    h.router.end("end-1", "g1", 3f, 4f, cancel = false)
    h.router.end("end-2", "g1", 3f, 4f, cancel = false)
    h.drain()
    assertEquals(2, h.pendingEndCount())

    h.dispatchers.single().completeLast() // initial press -> lift
    h.dispatchers.single().completeLast() // lift -> terminal callback

    assertEquals(
      listOf(
        Ack("start", true, null),
        Ack("duplicate", false, "Gesture g1 is already active"),
        Ack("end-1", true, null),
        Ack("end-2", true, null),
      ),
      h.acks,
    )
    assertEquals(1, h.dispatchers.size)
    assertEquals(0, h.pendingEndCount())

    // Reusing the id must not replay an old end request.
    h.router.start("next", "g1", 5f, 6f)
    h.drain()
    h.dispatchers.last().failLast("second gesture failed")
    assertEquals(1, h.acks.count { it.requestId == "end-1" })
    assertEquals(1, h.acks.count { it.requestId == "end-2" })
  }

  @Test
  fun `close lifts every active stroke before its callback and clears state`() {
    val h = RouterHarness()
    h.router.start("start", "g1", 1f, 2f)
    h.router.start("other-start", "g2", 5f, 6f)
    h.drain()
    h.router.end("end", "g1", 3f, 4f, cancel = false)
    h.drain()
    assertEquals(1, h.pendingEndCount())

    // Retain an unrelated terminal failure to verify teardown removes it.
    h.router.start("failed-start", "failed", 1f, 2f)
    h.drain()
    h.dispatchers.last().failLast("dispatch refused")
    assertEquals(1, h.terminalFailureCount())

    var cancelledBeforeClosed = false
    h.router.close {
      cancelledBeforeClosed =
        h.dispatchers.take(2).all { dispatcher ->
          dispatcher.dispatched.last().let { !it.willContinue && it.from == it.to }
        }
    }
    h.drain()
    assertTrue(cancelledBeforeClosed)
    assertEquals(2, h.dispatchers[0].dispatched.size)
    assertEquals(2, h.dispatchers[1].dispatched.size)
    assertEquals(
      listOf(Ack("end", false, "Gesture stream closed")),
      h.acks.filter { it.requestId == "end" },
    )
    assertEquals(0, h.pendingEndCount())
    assertEquals(0, h.terminalFailureCount())
  }

  @Test
  fun `close answers each pending end once and ignores later requests`() {
    val h = RouterHarness()
    h.router.start("start", "g1", 1f, 2f)
    h.router.end("end-1", "g1", 3f, 4f, cancel = false)
    h.router.end("end-2", "g1", 3f, 4f, cancel = false)
    h.drain()

    var closeCount = 0
    h.router.close { closeCount++ }
    h.drain()
    h.dispatchers.single().completeLast() // late lift callback cannot ack either end again
    h.router.close { closeCount++ }
    h.router.start("late-start", "g2", 1f, 2f)
    h.router.move("late-move", "g1", 2f, 3f)
    h.router.end("late-end", "g1", 2f, 3f, cancel = true)
    h.drain()

    assertEquals(2, closeCount)
    assertEquals(1, h.acks.count { it.requestId == "end-1" })
    assertEquals(1, h.acks.count { it.requestId == "end-2" })
    assertEquals(false, h.acks.last { it.requestId == "end-1" }.success)
    assertEquals(false, h.acks.last { it.requestId == "end-2" }.success)
    assertEquals(1, h.dispatchers.size)
    assertFalse(h.acks.any { it.requestId?.startsWith("late-") == true })
  }

  @Test
  fun `rejected close post still invokes its callback`() {
    val h = RouterHarness()
    h.router.close()
    h.drain()
    h.acceptPosts = false
    var closeCount = 0

    h.router.close { closeCount++ }

    assertEquals(1, closeCount)
  }
}
