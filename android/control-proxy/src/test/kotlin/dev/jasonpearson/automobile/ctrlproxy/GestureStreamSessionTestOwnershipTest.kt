package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.RequestGestureEnd
import dev.jasonpearson.automobile.protocol.RequestGestureStart
import dev.jasonpearson.automobile.protocol.WebSocketMessageHandler
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Client ownership, disconnect races, and isolation between gestures. */
@OptIn(ExperimentalCoroutinesApi::class)
internal class GestureStreamSessionTestOwnershipTest : GestureStreamSessionTestFixtures() {

  @Test
  fun `owner disconnect lifts a parked gesture once on the gesture thread and clears state`() {
    val h = RouterHarness()
    val owner = owner()
    h.router.start(RequestGestureStart("start", "g", 1.0, 2.0, 7), owner = owner)
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
    h.router.start(RequestGestureStart("replacement", "g", 3.0, 4.0), owner = owner())
    h.drain()
    assertEquals(2, h.dispatchers.size)
    dispatcher.completeLast()
    h.router.end(RequestGestureEnd("replacement-end", "g", 3.0, 4.0, false))
    h.drain()
    assertEquals(1, h.pendingEndCount())
    assertEquals(0, h.terminalFailureCount())
  }

  @Test
  fun `disconnect releases both gestures belonging to one owner`() {
    val h = RouterHarness()
    val client = owner()
    h.router.start(RequestGestureStart("start-first", "first", 1.0, 2.0), owner = client)
    h.router.start(RequestGestureStart("start-second", "second", 3.0, 4.0), owner = client)
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
    h.router.start(RequestGestureStart("start", "g", 1.0, 2.0))
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
    h.router.end(RequestGestureEnd("end", "g", 5.0, 6.0, false))
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
      h.router.start(RequestGestureStart("start", "g", 1.0, 2.0), owner = client)
      h.drain()
      val dispatcher = h.dispatchers.single()
      dispatcher.completeLast()
      h.router.end(RequestGestureEnd("end", "g", 3.0, 4.0, false), requester = client)
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
    h.router.start(RequestGestureStart("start", "g", 1.0, 2.0), owner = client)
    h.drain()
    val dispatcher = h.dispatchers.single()
    dispatcher.completeLast()
    h.router.end(RequestGestureEnd("other-end", "g", 3.0, 4.0, false), requester = other)
    h.router.end(RequestGestureEnd("owner-end", "g", 3.0, 4.0, false), requester = client)
    h.router.end(RequestGestureEnd("unattributed-end", "g", 3.0, 4.0, false))
    h.router.end(
      RequestGestureEnd("disconnected-end", "g", 3.0, 4.0, false),
      requester = disconnected,
    )
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
      h.router.start(RequestGestureStart("start", "g", 1.0, 2.0), owner = owner())
      h.drain()
      val dispatcher = h.dispatchers.single()
      dispatcher.completeLast()
      h.router.end(RequestGestureEnd("other-end", "g", 3.0, 4.0, false), requester = owner(2))
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
    h.router.start(RequestGestureStart("start", "g", 1.0, 2.0), owner = owner())
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
      h.router.start(RequestGestureStart("start", "g", 1.0, 2.0), owner = owner)
      h.drain()
      val dispatcher = h.dispatchers.single()
      dispatcher.completeLast()
      h.router.end(RequestGestureEnd("end", "g", 3.0, 4.0, false), requester = owner)
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
      h.router.start(RequestGestureStart("start", "g", 1.0, 2.0), owner = owner)
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
      h.router.start(RequestGestureStart("replacement", "g", 3.0, 4.0), owner = owner())
      h.drain()
      assertEquals(2, h.dispatchers.size)
    }
  }

  @Test
  fun `disconnect during a stroke ignores its stale callbacks and warns if the lift fails`() {
    val h = RouterHarness()
    val client = owner()
    h.router.start(RequestGestureStart("start", "g", 1.0, 2.0), owner = client)
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
    h.router.start(RequestGestureStart("start", "g", 1.0, 2.0), owner = owner)
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
                  RequestGestureStart(
                    request.requestId,
                    request.gestureId,
                    request.x.toFloat().toDouble(),
                    request.y.toFloat().toDouble(),
                  ),
                  owner = CommandOriginContext.currentClient(),
                )
              is RequestGestureEnd ->
                h.router.end(
                  RequestGestureEnd(
                    request.requestId,
                    request.gestureId,
                    request.x.toFloat().toDouble(),
                    request.y.toFloat().toDouble(),
                    request.cancel,
                  ),
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
          replies =
            ConnectionReplyDependencies(
              reply = { _, _, _ -> error("Unexpected reply") },
              hasRequestOwner = { false },
            ),
          logging =
            ConnectionLogDependencies(
              logError = { _, error -> throw AssertionError(error) },
              logWarning = { error(it) },
              logDebug = {},
            ),
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
      h.router.start(RequestGestureStart("replacement", "g", 3.0, 4.0), owner = owner())
      h.drain()
      assertEquals(2, h.dispatchers.size)
    }
  }

  @Test
  fun `disconnect before the posted session start dispatches no pointer`() {
    val h = RouterHarness()
    val client = owner()
    h.router.start(RequestGestureStart("start", "g", 1.0, 2.0), owner = client)
    h.router.cancelOwnedBy(client)
    h.drain()
    assertTrue(h.dispatchers.single().dispatched.isEmpty())
    h.router.start(RequestGestureStart("replacement", "g", 3.0, 4.0), owner = owner())
    h.drain()
    assertEquals(2, h.dispatchers.size)
  }

  @Test
  fun `owner disconnect cancels only its own gestures and keeps another owner's pending end`() {
    val h = RouterHarness()
    val a = owner(1)
    val b = owner(2)
    val c = owner(3)
    h.router.start(RequestGestureStart("start-a", "ga", 1.0, 2.0), owner = a)
    h.router.start(RequestGestureStart("start-b", "gb", 3.0, 4.0), owner = b)
    h.drain()
    h.dispatchers.forEach { it.completeLast() }
    // c ends b's gesture; a ends its own. Only a disconnects.
    h.router.end(RequestGestureEnd("c-end-b", "gb", 5.0, 6.0, cancel = false), requester = c)
    h.router.end(RequestGestureEnd("a-end-a", "ga", 5.0, 6.0, cancel = false), requester = a)
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
}
