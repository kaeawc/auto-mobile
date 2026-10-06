package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.RequestGestureEnd
import dev.jasonpearson.automobile.protocol.RequestGestureStart
import dev.jasonpearson.automobile.protocol.WebSocketMessageHandler
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import io.ktor.websocket.CloseReason
import java.util.ArrayDeque
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

/**
 * The Android-free continuation driver. Proves the pump loop chains the (already unit-tested)
 * coordinator's segments through the stroke dispatcher — one fresh initial stroke, the rest
 * continuations — and finishes exactly once, on both the lift and the dispatch-failure path.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class GestureStreamSessionTest {

  companion object {
    @BeforeClass
    @JvmStatic
    fun warmScheduler() {
      runTest {} // Keep coroutine scheduler initialization outside per-test timing.
    }
  }

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
    val warnings = mutableListOf<String>()
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
        logWarning = { warnings.add(it) },
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

  private fun owner(id: Int = 1) =
    WebSocketServer.ConnectedClient(
      id,
      object : WebSocketServer.ClientTransport {
        override suspend fun send(message: String) = Unit

        override suspend fun close(reason: CloseReason) = Unit
      },
      Channel(1),
      Channel(1),
    )

  @Test
  fun `owner disconnect lifts a parked gesture once on the gesture thread and clears state`() {
    val h = RouterHarness()
    val owner = owner()
    h.router.start("start", "g", 1f, 2f, 7, owner)
    h.drain()
    val dispatcher = h.dispatchers.single()
    dispatcher.completeLast() // press -> Wait
    h.router.cancelOwnedBy(owner)
    h.router.cancelOwnedBy(owner)
    assertEquals(1, dispatcher.dispatched.size) // IO caller must only post.
    h.drain()

    assertEquals(2, dispatcher.dispatched.size)
    val lift = dispatcher.calls.last().stroke
    assertSame(dispatcher.calls.first().stroke, lift.parent)
    assertFalse(lift.segment.willContinue)
    assertEquals(GesturePoint(1f, 2f), lift.segment.from)
    assertEquals(lift.segment.from, lift.segment.to)
    assertEquals(listOf(7, 7), dispatcher.displays)
    assertEquals(listOf(Ack("start", true, null)), h.acks)
    assertEquals(0, h.pendingEndCount())

    // Removal is immediate, without depending on a framework callback. An old callback must not
    // remove a replacement stream that reuses the wire id.
    h.router.start("replacement", "g", 3f, 4f, owner = owner())
    h.drain()
    assertEquals(2, h.dispatchers.size)
    dispatcher.completeLast()
    h.router.end("replacement-end", "g", 3f, 4f, false)
    h.drain()
    assertEquals(1, h.pendingEndCount())
    assertEquals(0, h.terminalFailureCount())
  }

  @Test
  fun `disconnect releases both gestures belonging to one owner`() {
    val h = RouterHarness()
    val client = owner()
    h.router.start("start-first", "first", 1f, 2f, owner = client)
    h.router.start("start-second", "second", 3f, 4f, owner = client)
    h.drain()
    h.dispatchers.forEach { it.completeLast() }

    h.router.cancelOwnedBy(client)
    h.router.cancelOwnedBy(client)
    h.drain()
    assertEquals(2, h.dispatchers.size)
    h.dispatchers.forEach { dispatcher ->
      assertEquals(2, dispatcher.dispatched.size)
      assertEquals(1, dispatcher.dispatched.count { !it.willContinue })
      assertSame(dispatcher.calls.first().stroke, dispatcher.calls.last().stroke.parent)
      dispatcher.completeLast()
    }
    assertEquals(
      listOf(Ack("start-first", true, null), Ack("start-second", true, null)),
      h.acks,
    )
    assertEquals(0, h.pendingEndCount())
    assertEquals(0, h.terminalFailureCount())
  }

  @Test
  fun `disconnect leaves an unowned gesture movable and endable`() {
    val h = RouterHarness()
    h.router.start("start", "g", 1f, 2f)
    h.drain()
    val dispatcher = h.dispatchers.single()
    dispatcher.completeLast()

    h.router.cancelOwnedBy(owner())
    h.drain()
    assertEquals(1, dispatcher.dispatched.size)
    assertEquals(0, dispatcher.dispatched.count { !it.willContinue })
    h.router.move("move", "g", 3f, 4f)
    h.drain()
    assertEquals(GesturePoint(3f, 4f), dispatcher.dispatched.last().to)
    assertTrue(dispatcher.dispatched.last().willContinue)
    dispatcher.completeLast()
    h.router.end("end", "g", 5f, 6f, false)
    h.drain()
    dispatcher.completeLast()
    assertEquals(1, dispatcher.dispatched.count { !it.willContinue })
    assertEquals(
      listOf(Ack("start", true, null), Ack("move", true, null), Ack("end", true, null)),
      h.acks,
    )
    assertEquals(0, h.pendingEndCount())
  }

  @Test
  fun `close after disconnect neither lifts again nor answers pending ends`() {
    for (releaseFinished in listOf(false, true)) {
      val h = RouterHarness()
      val client = owner()
      h.router.start("start", "g", 1f, 2f, owner = client)
      h.drain()
      val dispatcher = h.dispatchers.single()
      dispatcher.completeLast()
      h.router.end("end", "g", 3f, 4f, false, requester = client)
      h.drain()
      assertEquals(1, h.pendingEndCount())
      h.router.cancelOwnedBy(client)
      h.drain()
      val lift = dispatcher.calls.last()
      assertFalse(lift.stroke.segment.willContinue)
      if (releaseFinished) dispatcher.completeLast()

      var closedCount = 0
      h.router.close { closedCount++ }
      h.router.close { closedCount++ }
      h.drain()
      if (!releaseFinished) dispatcher.completeLast()
      // Replay the recorded lift callback even when no stroke remains in flight.
      lift.complete()
      h.drain()
      assertEquals(2, closedCount)
      assertEquals(1, dispatcher.dispatched.count { !it.willContinue })
      assertEquals(listOf(Ack("start", true, null)), h.acks)
      assertEquals(0, h.pendingEndCount())
      assertEquals(0, h.terminalFailureCount())
    }
  }

  @Test
  fun `owner disconnect fails another connected client's pending end exactly once`() {
    val h = RouterHarness()
    val client = owner()
    val other = owner(2)
    val disconnected = owner(3)
    h.router.start("start", "g", 1f, 2f, owner = client)
    h.drain()
    val dispatcher = h.dispatchers.single()
    dispatcher.completeLast()
    h.router.end("other-end", "g", 3f, 4f, false, requester = other)
    h.router.end("owner-end", "g", 3f, 4f, false, requester = client)
    h.router.end("unattributed-end", "g", 3f, 4f, false)
    h.router.end("disconnected-end", "g", 3f, 4f, false, requester = disconnected)
    h.drain()
    assertEquals(4, h.pendingEndCount())
    client.isConnected = false
    disconnected.isConnected = false

    h.router.cancelOwnedBy(client)
    h.router.cancelOwnedBy(client)
    h.drain()
    val expected =
      listOf(
        Ack("start", true, null),
        Ack("other-end", false, "Gesture owner disconnected"),
        Ack("unattributed-end", false, "Gesture owner disconnected"),
      )
    assertEquals(expected, h.acks)
    assertEquals(0, h.pendingEndCount())
    // The already dispatched lift may still finish after disconnect and service teardown.
    h.router.close()
    h.drain()
    dispatcher.completeLast()
    dispatcher.calls.last().complete()
    dispatcher.calls.last().fail("stale failure")
    assertEquals(expected, h.acks)
    assertEquals(1, dispatcher.dispatched.count { !it.willContinue })
    assertEquals(0, h.terminalFailureCount())
  }

  @Test
  fun `another client's pending end receives the session result without disconnect`() {
    for (success in listOf(true, false)) {
      val h = RouterHarness()
      h.router.start("start", "g", 1f, 2f, owner = owner())
      h.drain()
      val dispatcher = h.dispatchers.single()
      dispatcher.completeLast()
      h.router.end("other-end", "g", 3f, 4f, false, requester = owner(2))
      h.drain()
      assertEquals(1, h.pendingEndCount())
      val failure = if (success) null else "lift failed"
      if (success) dispatcher.completeLast() else dispatcher.failLast(requireNotNull(failure))
      dispatcher.calls.last().complete()
      assertEquals(listOf(Ack("start", true, null), Ack("other-end", success, failure)), h.acks)
      assertEquals(0, h.pendingEndCount())
    }
  }

  @Test
  fun `disconnect without a gesture dispatches nothing`() {
    val h = RouterHarness()
    h.router.cancelOwnedBy(owner())
    h.drain()
    assertTrue(h.dispatchers.isEmpty())
    assertTrue(h.acks.isEmpty())
    assertTrue(h.warnings.isEmpty())
  }

  @Test
  fun `disconnect leaves another owner's parked gesture untouched`() {
    val h = RouterHarness()
    h.router.start("start", "g", 1f, 2f, owner = owner())
    h.drain()
    val dispatcher = h.dispatchers.single()
    dispatcher.completeLast()
    h.router.cancelOwnedBy(owner())
    h.drain()
    assertEquals(1, dispatcher.dispatched.size)
    h.router.move("move", "g", 3f, 4f)
    h.drain()
    assertTrue(dispatcher.dispatched.last().willContinue)
    assertEquals(GesturePoint(3f, 4f), dispatcher.dispatched.last().to)
  }

  @Test
  fun `disconnect racing a posted end drops its reply and dispatches one lift`() {
    for (endDispatched in listOf(false, true)) {
      val h = RouterHarness()
      val owner = owner()
      h.router.start("start", "g", 1f, 2f, owner = owner)
      h.drain()
      val dispatcher = h.dispatchers.single()
      dispatcher.completeLast()
      h.router.end("end", "g", 3f, 4f, false, requester = owner)
      if (endDispatched) h.drain()
      h.router.cancelOwnedBy(owner)
      h.drain()
      dispatcher.completeLast()
      h.router.cancelOwnedBy(owner)
      h.drain()

      assertEquals(1, dispatcher.dispatched.count { !it.willContinue })
      assertEquals(listOf(Ack("start", true, null)), h.acks)
      assertEquals(0, h.pendingEndCount())
      assertEquals(0, h.terminalFailureCount())
    }
  }

  @Test
  fun `disconnect release failure warns clears state and never retries the lift`() {
    for (failure in listOf("failure", "rejection", "exception", "build")) {
      val h = RouterHarness()
      val owner = owner()
      h.router.start("start", "g", 1f, 2f, owner = owner)
      h.drain()
      val dispatcher = h.dispatchers.single()
      dispatcher.completeLast()
      if (failure == "exception")
        dispatcher.nextDispatchError = IllegalStateException("release failed")
      if (failure == "build") dispatcher.nextContinueError = IllegalStateException("release failed")
      h.router.cancelOwnedBy(owner)
      h.drain()
      if (failure == "failure") dispatcher.failLast("release failed")
      if (failure == "rejection") dispatcher.rejectLast("release failed")
      h.router.cancelOwnedBy(owner)
      h.drain()

      assertEquals(
        if (failure == "build") 0 else 1,
        dispatcher.dispatched.count { !it.willContinue },
      )
      assertEquals(1, h.warnings.size)
      assertTrue(h.warnings.single().contains("release failed"))
      assertEquals(listOf(Ack("start", true, null)), h.acks)
      assertEquals(0, h.terminalFailureCount())
      h.router.start("replacement", "g", 3f, 4f, owner = owner())
      h.drain()
      assertEquals(2, h.dispatchers.size)
    }
  }

  @Test
  fun `disconnect during a stroke ignores its stale callbacks and warns if the lift fails`() {
    val h = RouterHarness()
    val client = owner()
    h.router.start("start", "g", 1f, 2f, owner = client)
    h.drain()
    val dispatcher = h.dispatchers.single()
    val press = dispatcher.calls.single()
    h.router.cancelOwnedBy(client)
    h.drain()
    press.complete()
    press.fail("old press cancelled")
    press.reject("old press rejected")
    assertTrue(h.warnings.isEmpty())
    dispatcher.failLast("release failed")
    dispatcher.calls.last().complete()
    dispatcher.calls.last().fail("duplicate release failure")
    assertEquals(1, h.warnings.size)
    assertTrue(h.warnings.single().contains("release failed"))
    assertEquals(1, dispatcher.dispatched.count { !it.willContinue })
    assertEquals(listOf(Ack("start", true, null)), h.acks)
  }

  @Test
  fun `a start posted after disconnect cannot recreate an orphaned gesture`() {
    val h = RouterHarness()
    val owner = owner()
    owner.isConnected = false
    h.router.cancelOwnedBy(owner)
    h.router.start("start", "g", 1f, 2f, owner = owner)
    h.drain()
    assertTrue(h.dispatchers.isEmpty())
    assertTrue(h.acks.isEmpty())
  }

  @Test
  fun `disconnect releases a gesture when its queued end is discarded`() = runTest {
    for (cancel in listOf(false, true)) {
      val h = RouterHarness()
      val client = owner()
      val origin =
        object : QueuedCommandOrigin {
          override val client = client
          override val lifetime: Job = backgroundScope.coroutineContext[Job]!!
          override val ownerRecorded = false

          override suspend fun sendError(response: ErrorResponse) = error("Unexpected error")
        }
      val calls = mutableListOf<String?>()
      val delegate =
        object : WebSocketMessageHandler {
          override suspend fun handleMessage(request: WebSocketRequest): WebSocketResponse? {
            calls.add(request.requestId)
            when (request) {
              is RequestGestureStart ->
                h.router.start(
                  request.requestId,
                  request.gestureId,
                  request.x.toFloat(),
                  request.y.toFloat(),
                  owner = CommandOriginContext.currentClient(),
                )
              is RequestGestureEnd ->
                h.router.end(
                  request.requestId,
                  request.gestureId,
                  request.x.toFloat(),
                  request.y.toFloat(),
                  request.cancel,
                )
              else -> error("Unexpected request")
            }
            return null
          }
        }
      val dispatcher = StandardTestDispatcher(testScheduler)
      val commands =
        ConnectionCommandQueue(
          scope = CoroutineScope(backgroundScope.coroutineContext + dispatcher),
          dispatcher = dispatcher,
          delegate = delegate,
          reply = { _, _, _ -> error("Unexpected reply") },
          hasRequestOwner = { false },
          logError = { _, error -> throw AssertionError(error) },
          logWarning = { error(it) },
          logDebug = {},
        )
      commands.enqueue(origin, RequestGestureStart("start", "g", 1.0, 2.0))
      runCurrent()
      h.drain()
      val strokes = h.dispatchers.single()
      strokes.completeLast() // press -> Wait
      commands.enqueue(origin, RequestGestureEnd("end", "g", 3.0, 4.0, cancel))
      commands.disconnect(client)
      h.router.cancelOwnedBy(client)
      runCurrent()
      h.drain()
      strokes.completeLast()

      assertEquals(listOf("start"), calls)
      assertEquals(0, commands.connectionCount)
      assertEquals(1, strokes.dispatched.count { !it.willContinue })
      assertEquals(strokes.dispatched.last().from, strokes.dispatched.last().to)
      assertEquals(listOf(Ack("start", true, null)), h.acks)
      assertEquals(0, h.pendingEndCount())
      h.router.start("replacement", "g", 3f, 4f, owner = owner())
      h.drain()
      assertEquals(2, h.dispatchers.size)
    }
  }

  @Test
  fun `disconnect before the posted session start dispatches no pointer`() {
    val h = RouterHarness()
    val client = owner()
    h.router.start("start", "g", 1f, 2f, owner = client)
    h.router.cancelOwnedBy(client)
    h.drain()
    assertTrue(h.dispatchers.single().dispatched.isEmpty())
    h.router.start("replacement", "g", 3f, 4f, owner = owner())
    h.drain()
    assertEquals(2, h.dispatchers.size)
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
  fun `owner disconnect cancels only its own gestures and keeps another owner's pending end`() {
    val h = RouterHarness()
    val a = owner(1)
    val b = owner(2)
    val c = owner(3)
    h.router.start("start-a", "ga", 1f, 2f, owner = a)
    h.router.start("start-b", "gb", 3f, 4f, owner = b)
    h.drain()
    h.dispatchers.forEach { it.completeLast() }
    // c ends b's gesture; a ends its own. Only a disconnects.
    h.router.end("c-end-b", "gb", 5f, 6f, cancel = false, requester = c)
    h.router.end("a-end-a", "ga", 5f, 6f, cancel = false, requester = a)
    h.drain()
    assertEquals(2, h.pendingEndCount())
    a.isConnected = false

    h.router.cancelOwnedBy(a)
    h.drain()
    val (dispatcherA, dispatcherB) = h.dispatchers
    // a's gesture is lifted once and a's own end gets nothing; b's gesture is not cancelled.
    assertEquals(1, dispatcherA.dispatched.count { !it.willContinue })
    assertEquals(1, h.pendingEndCount())
    assertEquals(listOf(Ack("start-a", true, null), Ack("start-b", true, null)), h.acks)

    // b's gesture still completes normally and answers c exactly once.
    dispatcherB.completeLast()
    assertEquals(1, dispatcherB.dispatched.count { !it.willContinue })
    assertEquals(Ack("c-end-b", true, null), h.acks.last())
    assertEquals(1, h.acks.count { it.requestId == "c-end-b" })
    assertEquals(0, h.pendingEndCount())
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
