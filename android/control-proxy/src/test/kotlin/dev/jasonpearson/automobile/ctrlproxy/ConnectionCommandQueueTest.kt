package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.RequestCancelImeCommit
import dev.jasonpearson.automobile.protocol.RequestClipboard
import dev.jasonpearson.automobile.protocol.RequestCommitText
import dev.jasonpearson.automobile.protocol.RequestGestureEnd
import dev.jasonpearson.automobile.protocol.RequestHierarchy
import dev.jasonpearson.automobile.protocol.WebSocketMessageHandler
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlin.coroutines.Continuation
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.startCoroutine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ConnectionCommandQueueTest {
  private class FakeHandler(val body: suspend (WebSocketRequest) -> WebSocketResponse? = { null }) :
    WebSocketMessageHandler {
    val calls = mutableListOf<String?>()

    override suspend fun handleMessage(request: WebSocketRequest): WebSocketResponse? {
      calls += request.requestId
      return body(request)
    }
  }

  private class Frame(val request: WebSocketRequest) {
    val accepted = CompletableDeferred<WebSocketResponse?>()
  }

  private class ReadLoop(scope: CoroutineScope, handler: WebSocketMessageHandler) {
    private val frames = Channel<Frame>(Channel.UNLIMITED)
    val job = scope.launch {
      for (frame in frames) frame.accepted.complete(handler.handleMessage(frame.request))
    }

    suspend fun send(request: WebSocketRequest): WebSocketResponse? {
      val frame = Frame(request)
      frames.send(frame)
      return frame.accepted.await()
    }
  }

  private class Fixture(test: TestScope, delegate: WebSocketMessageHandler, capacity: Int = 2) {
    val replies = mutableListOf<WebSocketResponse>()
    val failures = mutableListOf<Throwable>()
    val warnings = mutableListOf<String>()
    val owners = mutableSetOf<String>()
    var ownerProbe: (String) -> Boolean = { it in owners }
    val errorReplies: List<Pair<String?, String>>
      get() = replies.map { (it as ErrorResponse).let { error -> error.requestId to error.error } }

    val scope =
      CoroutineScope(
        test.backgroundScope.coroutineContext + StandardTestDispatcher(test.testScheduler)
      )
    val queue =
      ConnectionCommandQueue<Job>(
        scope = scope,
        dispatcher = StandardTestDispatcher(test.testScheduler),
        delegate = delegate,
        reply = { requestId, response, routing ->
          if (routing != QueuedReplyRouting.OWNER || requestId in owners) {
            replies += response
            owners.remove(requestId)
          }
        },
        hasRequestOwner = { ownerProbe(it) },
        logError = { _, error -> failures += error },
        logWarning = { warnings += it },
        logDebug = {},
        capacity = capacity,
      )
    val handler = QueuedWebSocketMessageHandler(delegate, queue)

    fun connection() = ReadLoop(scope, handler)
  }

  @Test
  fun `slow command leaves both read loops free and connections independent`() = runTest {
    val held = CompletableDeferred<Unit>()
    val delegate = FakeHandler { request ->
      if (request.requestId == "held") held.await()
      CorrelatedErrorReporter.frame(request.requestId, "reply")
    }
    val fixture = Fixture(this, delegate)
    val first = fixture.connection()
    val second = fixture.connection()
    assertNull(first.send(RequestHierarchy(requestId = "held")))
    runCurrent()
    assertNull(second.send(RequestHierarchy(requestId = "other")))
    runCurrent()
    assertFalse(held.isCompleted)
    assertEquals(listOf("held", "other"), delegate.calls)
    assertEquals(
      listOf("other"),
      fixture.replies.map { (it as ErrorResponse).requestId },
    )
    held.complete(Unit)
    runCurrent()
    assertEquals(2, fixture.replies.size)
  }

  @Test
  fun `same connection enqueues immediately and runs commands strictly in order`() = runTest {
    val held = CompletableDeferred<Unit>()
    val delegate = FakeHandler { request ->
      if (request.requestId == "first") held.await()
      null
    }
    val fixture = Fixture(this, delegate)
    val connection = fixture.connection()
    assertNull(connection.send(RequestHierarchy(requestId = "first")))
    assertNull(connection.send(RequestHierarchy(requestId = "second")))
    runCurrent()
    assertEquals(listOf("first"), delegate.calls)
    held.complete(Unit)
    runCurrent()
    assertEquals(listOf("first", "second"), delegate.calls)
  }

  @Test
  fun `cancel bypasses slow unrelated command without cancelling it or replying for commit`() =
    runTest {
      val held = CompletableDeferred<Unit>()
      var finished = false
      val delegate = FakeHandler { request ->
        if (request.requestId == "held") {
          held.await()
          finished = true
        }
        null
      }
      val fixture = Fixture(this, delegate)
      val connection = fixture.connection()
      connection.send(RequestHierarchy(requestId = "held"))
      connection.send(RequestHierarchy(requestId = "next"))
      connection.send(RequestCancelImeCommit(requestId = "cancel", targetRequestId = "commit"))
      runCurrent()
      assertEquals(listOf("held", "cancel"), delegate.calls)
      assertFalse(finished)
      assertTrue(fixture.replies.isEmpty())
      held.complete(Unit)
      runCurrent()
      assertTrue(finished)
      assertEquals(listOf("held", "cancel", "next"), delegate.calls)
      assertTrue(fixture.replies.isEmpty())
      assertTrue(fixture.failures.isEmpty())
    }

  @Test
  fun `cancel for queued command reaches delegate and tombstoned command still runs`() = runTest {
    val held = CompletableDeferred<Unit>()
    val tombstones = mutableSetOf<String>()
    var sawTombstone = false
    val delegate = FakeHandler { request ->
      when {
        request is RequestCancelImeCommit -> tombstones += request.targetRequestId
        request.requestId == "held" -> held.await()
        request.requestId == "queued" -> sawTombstone = "queued" in tombstones
      }
      null
    }
    val fixture = Fixture(this, delegate)
    val connection = fixture.connection()
    connection.send(RequestHierarchy(requestId = "held"))
    connection.send(RequestHierarchy(requestId = "queued"))
    connection.send(RequestCancelImeCommit(targetRequestId = "queued", requestId = "cancel"))
    assertEquals(listOf("held", "cancel"), delegate.calls)
    assertTrue(fixture.replies.isEmpty())
    held.complete(Unit)
    runCurrent()
    assertTrue(sawTombstone)
    assertEquals(listOf("held", "cancel", "queued"), delegate.calls)
  }

  @Test
  fun `gesture end cancellation stays ordered`() = runTest {
    val held = CompletableDeferred<Unit>()
    val delegate = FakeHandler { request ->
      if (request.requestId == "held") held.await()
      null
    }
    val fixture = Fixture(this, delegate)
    val connection = fixture.connection()
    connection.send(RequestHierarchy(requestId = "held"))
    connection.send(
      RequestGestureEnd(requestId = "end", gestureId = "gesture", x = 0.0, y = 0.0, cancel = true)
    )
    runCurrent()
    assertEquals(listOf("held"), delegate.calls)
    held.complete(Unit)
    runCurrent()
    assertEquals(listOf("held", "end"), delegate.calls)
  }

  @Test
  fun `full queue rejects without waiting and uncorrelated rejection only logs`() = runTest {
    val held = CompletableDeferred<Unit>()
    val delegate = FakeHandler { request ->
      if (request.requestId == "held") held.await()
      null
    }
    val fixture = Fixture(this, delegate, capacity = 1)
    val connection = fixture.connection()
    connection.send(RequestHierarchy(requestId = "held"))
    connection.send(RequestHierarchy(requestId = "pending"))
    assertNull(connection.send(RequestHierarchy(requestId = "rejected")))
    assertNull(connection.send(RequestHierarchy()))
    assertEquals(
      listOf("rejected" to "ctrlproxy_busy: command queue full (1 pending); retry"),
      fixture.errorReplies,
    )
    assertEquals(2, fixture.warnings.size)
    held.complete(Unit)
    runCurrent()
    assertEquals(listOf("held", "pending"), delegate.calls)
  }

  @Test
  fun `busy owned command uses snapshot even when ownership disappears before rejection`() =
    runTest {
      val held = CompletableDeferred<Unit>()
      val fixture =
        Fixture(
          this,
          FakeHandler { request ->
            if (request.requestId == "held") held.await()
            null
          },
          capacity = 1,
        )
      val connection = fixture.connection()
      connection.send(RequestHierarchy(requestId = "held"))
      connection.send(RequestHierarchy(requestId = "pending"))
      fixture.owners += "rejected"
      fixture.ownerProbe = { requestId ->
        if (requestId == "rejected") {
          // Disconnect/consumption wins before the reply sink runs.
          fixture.owners.remove(requestId)
          true
        } else requestId in fixture.owners
      }
      connection.send(RequestClipboard(requestId = "rejected", action = "get"))
      assertEquals(1, fixture.warnings.size)
      assertTrue(fixture.replies.isEmpty())
      held.complete(Unit)
      runCurrent()
      assertTrue(fixture.replies.isEmpty())
    }

  @Test
  fun `connection completion cancels child drops pending work and removes entry`() = runTest {
    val cancelled = CompletableDeferred<Unit>()
    val delegate = FakeHandler {
      try {
        awaitCancellation()
      } finally {
        cancelled.complete(Unit)
      }
    }
    val fixture = Fixture(this, delegate)
    val connection = fixture.connection()
    connection.send(RequestHierarchy(requestId = "held"))
    connection.send(RequestHierarchy(requestId = "pending"))
    connection.job.cancelAndJoin()
    runCurrent()
    assertTrue(cancelled.isCompleted)
    assertEquals(listOf("held"), delegate.calls)
    assertEquals(0, fixture.queue.connectionCount)
    assertTrue(fixture.replies.isEmpty())
  }

  @Test
  fun `delegate throw is correlated and following returned response is forwarded`() = runTest {
    val failure = IllegalStateException("broken")
    val delegate = FakeHandler { request ->
      if (request.requestId == "throw") throw failure
      if (request.requestId == "cancelled") throw CancellationException("cooperative cancellation")
      CorrelatedErrorReporter.frame(request.requestId, "returned")
    }
    val fixture = Fixture(this, delegate)
    val connection = fixture.connection()
    connection.send(RequestHierarchy(requestId = "throw"))
    connection.send(RequestHierarchy(requestId = "cancelled"))
    connection.send(RequestHierarchy(requestId = "return"))
    runCurrent()
    assertEquals(
      listOf(
        "throw" to "Handler error: broken",
        "return" to "returned",
      ),
      fixture.errorReplies,
    )
    assertEquals(listOf(failure), fixture.failures)
  }

  @Test
  fun `targeted cancel never cancels active handler or sends Command cancelled`() = runTest {
    val held = CompletableDeferred<Unit>()
    var finished = false
    val delegate = FakeHandler { request ->
      if (request.requestId == "commit") {
        held.await()
        finished = true
      }
      null
    }
    val fixture = Fixture(this, delegate)
    fixture.owners += "commit"
    val connection = fixture.connection()
    connection.send(RequestCommitText(requestId = "commit", text = "abcd"))
    connection.send(RequestCancelImeCommit(targetRequestId = "commit"))
    runCurrent()
    assertTrue(fixture.replies.isEmpty())
    assertTrue("delegate still owns the eventual commit reply", "commit" in fixture.owners)
    held.complete(Unit)
    runCurrent()
    assertTrue(finished)
    assertTrue(fixture.replies.isEmpty())
  }

  @Test
  fun `inactive lifetime drops dequeued command before completion hook runs`() = runTest {
    val lifetime = Job()
    val finishCleanup = CompletableDeferred<Unit>()
    val child =
      launch(lifetime) {
        try {
          awaitCancellation()
        } finally {
          withContext(NonCancellable) { finishCleanup.await() }
        }
      }
    runCurrent()
    val delegate = FakeHandler()
    val fixture = Fixture(this, delegate)
    try {
      fixture.queue.enqueue(lifetime, lifetime, RequestHierarchy(requestId = "pending"))
      lifetime.cancel() // A child is still unwinding, so invokeOnCompletion has not run yet.
      assertFalse(lifetime.isActive)
      assertFalse(lifetime.isCompleted)
      runCurrent()
      assertTrue(delegate.calls.isEmpty())
      finishCleanup.complete(Unit)
      child.join()
      runCurrent()
      assertTrue(delegate.calls.isEmpty())
      assertEquals(0, fixture.queue.connectionCount)
    } finally {
      finishCleanup.complete(Unit)
      lifetime.cancel()
      child.cancelAndJoin()
    }
  }

  @Test
  fun `generic key and service shutdown clean up workers without connection shutdown`() = runTest {
    val service = Job()
    val scope = CoroutineScope(service + StandardTestDispatcher(testScheduler))
    val lifetime = Job()
    val calls = mutableListOf<String?>()
    val queue =
      ConnectionCommandQueue<String>(
        scope,
        StandardTestDispatcher(testScheduler),
        FakeHandler {
          calls += it.requestId
          awaitCancellation()
        },
        reply = { _, _, _ -> error("shutdown must not reply") },
        hasRequestOwner = { false },
        logError = { _, error -> throw AssertionError(error) },
        logWarning = { error(it) },
        logDebug = {},
      )
    try {
      val finishedConnection = Job()
      queue.enqueue("finished", finishedConnection, RequestHierarchy(requestId = "finished"))
      runCurrent()
      finishedConnection.complete()
      runCurrent()
      assertEquals(0, queue.connectionCount)
      queue.enqueue("finished", finishedConnection, RequestHierarchy(requestId = "dropped"))
      assertEquals(0, queue.connectionCount)
      queue.enqueue("connection", lifetime, RequestHierarchy(requestId = "held"))
      runCurrent()
      service.cancelAndJoin()
      assertTrue(lifetime.isActive)
      assertEquals(listOf("finished", "held"), calls)
      assertEquals(0, queue.connectionCount)
    } finally {
      lifetime.cancel()
      service.cancel()
    }
  }

  @Test
  fun `missing job keeps inline delegate suspension and returns its response`() = runTest {
    val held = CompletableDeferred<Unit>()
    val expected = CorrelatedErrorReporter.frame("inline", "reply")
    val delegate = FakeHandler {
      held.await()
      expected
    }
    val fixture = Fixture(this, delegate)
    val completed = CompletableDeferred<WebSocketResponse?>()
    val call: suspend () -> WebSocketResponse? = {
      fixture.handler.handleMessage(RequestHierarchy(requestId = "inline"))
    }
    call.startCoroutine(
      object : Continuation<WebSocketResponse?> {
        override val context = EmptyCoroutineContext

        override fun resumeWith(result: Result<WebSocketResponse?>) {
          completed.complete(result.getOrThrow())
        }
      }
    )
    assertEquals(listOf("inline"), delegate.calls)
    assertFalse(completed.isCompleted)
    assertEquals(0, fixture.queue.connectionCount)
    held.complete(Unit)
    assertEquals(expected, completed.await())
    assertTrue(fixture.replies.isEmpty())
  }
}
