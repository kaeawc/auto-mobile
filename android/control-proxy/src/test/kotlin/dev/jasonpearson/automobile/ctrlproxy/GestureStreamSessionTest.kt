package dev.jasonpearson.automobile.ctrlproxy

import java.util.ArrayDeque
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Android-free continuation driver. Proves the pump loop chains the (already unit-tested)
 * coordinator's segments through the stroke dispatcher — one fresh initial stroke, the rest
 * continuations — and finishes exactly once, on both the lift and the dispatch-failure path.
 */
class GestureStreamSessionTest {

  @Test
  fun `router forwards the start display through queued continuations`() {
    val h = RouterHarness()
    h.router.start("start", "g", 1f, 2f, 7)
    h.drain()
    h.router.move("move", "g", 3f, 4f)
    h.drain()
    val dispatcher = h.dispatchers.single()
    dispatcher.completeLast()
    h.router.end("end", "g", 5f, 6f, false)
    h.drain()
    dispatcher.completeLast()
    dispatcher.completeLast()
    assertEquals(listOf(7, 7, 7), dispatcher.displays)
    assertEquals(Ack("end", true, null), h.acks.last())
  }

  @Test
  fun `start display is retained through move end and cancellation`() {
    for (displayId in listOf(null, 0, 7)) {
      for (cancel in listOf(false, true)) {
        val runner = Session()
        runner.session.start(1f, 2f, displayId)
        runner.session.move(3f, 4f)
        runner.dispatcher.completeLast()
        runner.session.end(5f, 6f, cancel)
        runner.dispatcher.completeLast()
        runner.dispatcher.completeLast()
        assertEquals(listOf(displayId, displayId, displayId), runner.dispatcher.displays)
        assertEquals(true, runner.finishedSuccess)
      }
    }
  }

  private class FakeStroke(val segment: GestureSegment, val parent: FakeStroke? = null)

  private class FakeStrokeDispatcher(
    private val initialError: Exception? = null,
    private val continueError: Exception? = null,
    private val dispatchError: Exception? = null,
  ) : StrokeDispatcher<FakeStroke> {
    data class Call(
      val stroke: FakeStroke,
      val complete: () -> Unit,
      val fail: (String) -> Unit,
      val reject: (String) -> Unit,
    )

    val calls = mutableListOf<Call>()
    val dispatched = mutableListOf<GestureSegment>()
    val displays = mutableListOf<Int?>()
    var initialCount = 0
    var continueCount = 0
    var nextContinueError: Exception? = null
    var nextDispatchError: Exception? = null
    private var pending: Call? = null

    override fun initialStroke(segment: GestureSegment): FakeStroke {
      initialCount++
      initialError?.let { throw it }
      return FakeStroke(segment)
    }

    override fun continueStroke(previous: FakeStroke, segment: GestureSegment): FakeStroke {
      continueCount++
      val nextError = nextContinueError
      nextContinueError = null
      nextError?.let { throw it }
      continueError?.let { throw it }
      return FakeStroke(segment, previous)
    }

    override fun dispatch(
      stroke: FakeStroke,
      onComplete: () -> Unit,
      onFailed: (error: String) -> Unit,
      displayId: Int?,
    ) = dispatchContinuing(stroke, onComplete, onFailed, onFailed, displayId)

    override fun dispatchContinuing(
      stroke: FakeStroke,
      onComplete: () -> Unit,
      onFailed: (error: String) -> Unit,
      onRejected: (error: String) -> Unit,
      displayId: Int?,
    ) {
      dispatched.add(stroke.segment)
      displays.add(displayId)
      val call = Call(stroke, onComplete, onFailed, onRejected)
      calls.add(call)
      pending = call
      val nextError = nextDispatchError
      nextDispatchError = null
      nextError?.let { throw it }
      dispatchError?.let { throw it }
    }

    /** Fire the in-flight stroke's completion, driving the loop one step. */
    fun completeLast() {
      val call = requireNotNull(pending) { "no stroke in flight" }
      pending = null
      call.complete()
    }

    fun failLast(error: String) {
      val call = requireNotNull(pending) { "no stroke in flight" }
      pending = null
      call.fail(error)
    }

    fun rejectLast(error: String) {
      val call = requireNotNull(pending) { "no stroke in flight" }
      pending = null
      call.reject(error)
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

    fun assertRelease(anchor: FakeStroke, at: GesturePoint) {
      val release = dispatcher.calls.last().stroke
      assertSame(anchor, release.parent)
      assertEquals(GestureSegment(at, at, 1L, false, false, true), release.segment)
      assertEquals(0, finishCount)
    }

    fun assertFailedOnce(message: String) {
      assertEquals(1, finishCount)
      assertEquals(false, finishedSuccess)
      assertEquals(message, finishedError)
    }
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
  fun `negative move coordinates are clamped on every dispatched endpoint`() {
    for (target in listOf(GesturePoint(-5f, -7f), GesturePoint(-5f, 30f))) {
      val h = Session()
      h.session.start(10f, 10f)
      h.dispatcher.completeLast()
      h.session.move(target.x, target.y)

      val clampedTarget = GesturePoint(0f, target.y.coerceAtLeast(0f))
      assertEquals(GesturePoint(10f, 10f), h.dispatcher.dispatched[1].from)
      assertEquals(clampedTarget, h.dispatcher.dispatched[1].to)
      h.session.end(target.x, target.y, cancel = false)
      h.dispatcher.completeLast()
      assertEquals(clampedTarget, h.dispatcher.dispatched.last().from)
      assertEquals(clampedTarget, h.dispatcher.dispatched.last().to)
      h.dispatcher.completeLast()

      assertTrue(
        h.dispatcher.dispatched.all {
          it.from.x >= 0f && it.from.y >= 0f && it.to.x >= 0f && it.to.y >= 0f
        }
      )
      assertEquals(true, h.finishedSuccess)
    }
  }

  @Test
  fun `negative initial press and final lift are clamped and dispatched`() {
    val h = Session()
    h.session.start(-5f, -7f)
    h.dispatcher.completeLast()
    h.session.end(-5f, -7f, cancel = false)
    h.dispatcher.completeLast()

    assertEquals(2, h.dispatcher.dispatched.size)
    assertTrue(
      h.dispatcher.dispatched.all {
        it.from == GesturePoint(0f, 0f) && it.to == GesturePoint(0f, 0f)
      }
    )
    assertEquals(true, h.finishedSuccess)
  }

  @Test
  fun `initial and continuation build exceptions finish once without escaping`() {
    val message = "Path bounds must not be negative"
    for (initial in listOf(true, false)) {
      val error = IllegalArgumentException(message)
      val dispatcher =
        if (initial) FakeStrokeDispatcher(initialError = error) else FakeStrokeDispatcher()
      val h = Session(dispatcher)
      h.session.start(-5f, 10f, 7)
      if (!initial) {
        h.session.move(-5f, 30f)
        h.dispatcher.completeLast()
        h.dispatcher.nextContinueError = error
        h.session.move(20f, 30f)
        h.dispatcher.completeLast()
        h.assertRelease(h.dispatcher.calls[1].stroke, GesturePoint(0f, 30f))
        assertEquals(listOf(7, 7, 7), h.dispatcher.displays)
        h.session.move(40f, 50f)
        h.session.end(40f, 50f, cancel = false)
        h.session.cancel()
        assertEquals(3, h.dispatcher.dispatched.size)
        h.dispatcher.completeLast()
      } else {
        assertEquals(0, h.dispatcher.continueCount)
      }

      h.assertFailedOnce(message)
      val dispatchedCount = h.dispatcher.dispatched.size
      assertEquals(if (initial) 0 else 3, dispatchedCount)
      h.session.move(40f, 50f)
      h.session.end(40f, 50f, cancel = false)
      h.session.cancel()
      h.dispatcher.calls.lastOrNull()?.complete?.invoke()
      assertEquals(dispatchedCount, h.dispatcher.dispatched.size)
      h.assertFailedOnce(message)
    }
  }

  @Test
  fun `dispatch exceptions finish once even when stored callbacks fire later`() {
    for (initial in listOf(true, false)) {
      for (complete in listOf(true, false)) {
        val dispatcher =
          if (initial) FakeStrokeDispatcher(dispatchError = IllegalStateException())
          else FakeStrokeDispatcher()
        val h = Session(dispatcher)
        h.session.start(10f, 10f)
        if (!initial) {
          h.dispatcher.nextDispatchError = IllegalStateException()
          h.session.move(20f, 30f)
          h.dispatcher.completeLast()
          h.assertRelease(h.dispatcher.calls.first().stroke, GesturePoint(10f, 10f))
        }
        val failedCall = h.dispatcher.calls[if (initial) 0 else 1]

        h.session.move(40f, 50f)
        h.session.end(40f, 50f, cancel = false)
        h.session.cancel()
        if (complete) failedCall.complete() else failedCall.fail("late failure")
        failedCall.reject("late rejection")
        assertEquals(if (initial) 1 else 3, h.dispatcher.dispatched.size)
        assertEquals(if (initial) 1 else 0, h.finishCount)
        if (!initial) h.dispatcher.completeLast()
        h.assertFailedOnce("Failed to build streamed gesture stroke")
        failedCall.complete()
        failedCall.fail("later failure")
        assertEquals(if (initial) 1 else 3, h.dispatcher.dispatched.size)
        h.assertFailedOnce("Failed to build streamed gesture stroke")
      }
    }
  }

  @Test
  fun `continued build and release build exceptions preserve the original error`() {
    val message = "Path bounds must not be negative"
    val h = Session(FakeStrokeDispatcher(continueError = IllegalStateException("release exploded")))
    h.session.start(10f, 10f)
    h.dispatcher.nextContinueError = IllegalArgumentException(message)
    h.session.move(20f, 30f)
    h.dispatcher.completeLast()

    assertEquals(2, h.dispatcher.continueCount) // failed move, then failed release
    assertEquals(1, h.dispatcher.dispatched.size)
    h.assertFailedOnce(message)
    h.session.move(40f, 50f)
    h.session.end(40f, 50f, cancel = false)
    h.dispatcher.calls.first().complete()
    h.dispatcher.calls.first().fail("late failure")
    assertEquals(1, h.dispatcher.dispatched.size)
    h.assertFailedOnce(message)
  }

  @Test
  fun `initial dispatch rejection finishes without releasing an unregistered pointer`() {
    val h = Session()
    h.session.start(10f, 10f)
    val rejectedCall = h.dispatcher.calls.single()
    h.dispatcher.rejectLast("initial dispatch refused")

    assertEquals(0, h.dispatcher.continueCount)
    h.assertFailedOnce("initial dispatch refused")
    rejectedCall.complete()
    rejectedCall.fail("late cancellation")
    h.session.move(20f, 30f)
    h.session.end(20f, 30f, cancel = false)
    assertEquals(1, h.dispatcher.dispatched.size)
    h.assertFailedOnce("initial dispatch refused")
  }

  @Test
  fun `release dispatch failure rejection or exception preserves the original error`() {
    for (failure in listOf("failure", "rejection", "exception")) {
      val message = "Path bounds must not be negative"
      val h = Session()
      h.session.start(10f, 10f, 7)
      h.dispatcher.nextContinueError = IllegalArgumentException(message)
      if (failure == "exception") {
        h.dispatcher.nextDispatchError = IllegalStateException("release dispatch exploded")
      }
      h.session.move(20f, 30f)
      h.dispatcher.completeLast()

      if (failure != "exception") {
        h.assertRelease(h.dispatcher.calls.first().stroke, GesturePoint(10f, 10f))
        if (failure == "failure") h.dispatcher.failLast("release cancelled")
        else h.dispatcher.rejectLast("release refused")
      }
      assertEquals(2, h.dispatcher.dispatched.size)
      assertEquals(listOf(7, 7), h.dispatcher.displays)
      h.assertFailedOnce(message)
      val release = h.dispatcher.calls.last()
      release.complete()
      release.fail("late release failure")
      release.reject("late release rejection")
      h.session.move(40f, 50f)
      h.session.end(40f, 50f, cancel = false)
      assertEquals(2, h.dispatcher.dispatched.size)
      h.assertFailedOnce(message)
    }
  }

  @Test
  fun `rejection releases the preceding stroke but cancellation releases the current stroke`() {
    for (rejected in listOf(true, false)) {
      val h = Session()
      h.session.start(-5f, 10f, 7)
      h.session.move(-5f, 30f)
      h.dispatcher.completeLast()
      val failedCall = h.dispatcher.calls.last()
      val message = if (rejected) "dispatch refused" else "dispatch cancelled"
      if (rejected) h.dispatcher.rejectLast(message) else h.dispatcher.failLast(message)

      val anchor = if (rejected) h.dispatcher.calls.first().stroke else failedCall.stroke
      h.assertRelease(anchor, GesturePoint(0f, if (rejected) 10f else 30f))
      assertEquals(listOf(7, 7, 7), h.dispatcher.displays)
      failedCall.complete()
      failedCall.fail("duplicate failure")
      failedCall.reject("duplicate rejection")
      h.session.move(40f, 50f)
      h.session.end(40f, 50f, cancel = false)
      h.session.cancel()
      assertEquals(3, h.dispatcher.dispatched.size)
      assertEquals(0, h.finishCount)

      val release = h.dispatcher.calls.last()
      h.dispatcher.completeLast()
      release.complete()
      release.fail("late failure")
      failedCall.complete()
      h.session.move(60f, 70f)
      h.session.end(60f, 70f, cancel = false)
      assertEquals(3, h.dispatcher.dispatched.size)
      h.assertFailedOnce(message)
    }
  }

  @Test
  fun `collapsed negative moves park and recover with a continuous stroke before lifting`() {
    val h = Session()
    h.session.start(0f, 0f)
    h.dispatcher.completeLast()
    h.session.move(-5f, -7f)
    h.session.move(-10f, -20f)

    assertEquals(1, h.dispatcher.dispatched.size)
    assertEquals(0, h.dispatcher.continueCount)
    assertEquals(0, h.finishCount)
    assertNull(h.finishedSuccess)

    h.session.move(20f, 20f)
    assertEquals(2, h.dispatcher.dispatched.size)
    assertEquals(GesturePoint(0f, 0f), h.dispatcher.dispatched[1].from)
    assertEquals(GesturePoint(20f, 20f), h.dispatcher.dispatched[1].to)
    h.session.end(20f, 20f, cancel = false)
    h.dispatcher.completeLast()

    val lift = h.dispatcher.dispatched.last()
    assertEquals(3, h.dispatcher.dispatched.size)
    assertEquals(GesturePoint(20f, 20f), lift.from)
    assertEquals(lift.from, lift.to)
    assertFalse(lift.willContinue)
    h.dispatcher.completeLast()
    assertEquals(1, h.finishCount)
    assertEquals(true, h.finishedSuccess)
  }

  @Test
  fun `in bounds movement and genuine holds retain their exact endpoints`() {
    val h = Session()
    h.session.start(10f, 10f)
    h.dispatcher.completeLast()
    h.session.move(20f, 30f)
    h.dispatcher.completeLast()
    h.session.move(20f, 30f)
    assertTrue(h.dispatcher.dispatched.last().isHold)
    assertTrue(h.dispatcher.dispatched.last().willContinue)
    h.dispatcher.completeLast()
    h.session.end(20f, 30f, cancel = false)
    h.dispatcher.completeLast()

    assertEquals(
      listOf(
        GesturePoint(10f, 10f) to GesturePoint(10f, 10f),
        GesturePoint(10f, 10f) to GesturePoint(20f, 30f),
        GesturePoint(20f, 30f) to GesturePoint(20f, 30f),
        GesturePoint(20f, 30f) to GesturePoint(20f, 30f),
      ),
      h.dispatcher.dispatched.map { it.from to it.to },
    )
    assertEquals(1, h.dispatcher.initialCount)
    assertEquals(3, h.dispatcher.continueCount)
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

    h.assertRelease(h.dispatcher.calls.first().stroke, GesturePoint(10f, 10f))
    assertEquals(2, h.dispatcher.dispatched.size)
    h.dispatcher.completeLast()
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
    // releases and finishes first on the gesture thread; the queued end must consume that result.
    h.router.end("end", "g1", 3f, 4f, cancel = false)
    h.dispatchers.single().failLast("dispatch cancelled")
    assertEquals(1, h.acks.size)
    h.dispatchers.single().completeLast() // release -> terminal result before the queued end
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
    h.dispatchers.single().completeLast() // release -> terminal failure retained for a late end
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
      h.dispatchers.last().completeLast() // release -> retain the unclaimed terminal failure
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

    assertEquals(listOf(Ack("start", true, null)), h.acks)
    assertEquals(1, h.pendingEndCount())
    h.dispatchers.single().completeLast() // release -> notify the registered end
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
    h.dispatchers.last().completeLast() // release -> fail only the new gesture
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
    h.dispatchers.last().completeLast() // release -> retain the unrelated terminal failure
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
