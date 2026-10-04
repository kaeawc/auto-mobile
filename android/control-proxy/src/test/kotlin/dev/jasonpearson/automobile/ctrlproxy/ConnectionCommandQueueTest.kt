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
import io.ktor.websocket.CloseReason
import java.util.concurrent.Executors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
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

  companion object {
    @BeforeClass
    @JvmStatic
    fun warmScheduler() {
      runTest {} // Keep coroutine scheduler initialization outside per-test timing.
    }

    private fun client() =
      WebSocketServer.ConnectedClient(
        1,
        object : WebSocketServer.ClientTransport {
          override suspend fun send(message: String) = Unit

          override suspend fun close(reason: CloseReason) = Unit
        },
        Channel(1),
        Channel(1),
      )
  }

  private class FakeOrigin(
    override val client: WebSocketServer.ConnectedClient,
    override val lifetime: Job,
    override val ownerRecorded: Boolean = false,
    private val errors: suspend (ErrorResponse) -> Unit = {},
  ) : QueuedCommandOrigin {
    override suspend fun sendError(response: ErrorResponse) = errors(response)
  }

  private class Frame(val request: WebSocketRequest, val ownerRecorded: Boolean) {
    val accepted = CompletableDeferred<WebSocketResponse?>()
  }

  private class ReadLoop(
    scope: CoroutineScope,
    handler: WebSocketMessageHandler,
    val client: WebSocketServer.ConnectedClient,
    errors: suspend (ErrorResponse) -> Unit,
  ) {
    private val frames = Channel<Frame>(Channel.UNLIMITED)
    val job = scope.launch {
      for (frame in frames) {
        val origin = FakeOrigin(client, currentCoroutineContext().job, frame.ownerRecorded, errors)
        frame.accepted.complete(
          withContext(CommandOriginContext(origin)) {
            handler.handleMessage(frame.request)
          }
        )
      }
    }

    suspend fun send(
      request: WebSocketRequest,
      ownerRecorded: Boolean = false,
    ): WebSocketResponse? {
      val frame = Frame(request, ownerRecorded)
      frames.send(frame)
      return frame.accepted.await()
    }
  }

  private class Fixture(test: TestScope, delegate: WebSocketMessageHandler, capacity: Int = 2) {
    val replies = mutableListOf<WebSocketResponse>()
    val failures = mutableListOf<Throwable>()
    val warnings = mutableListOf<String>()
    val owners = mutableSetOf<String>()
    val errorReplies: List<Pair<String?, String>>
      get() = replies.map { (it as ErrorResponse).let { error -> error.requestId to error.error } }

    val scope =
      CoroutineScope(
        test.backgroundScope.coroutineContext + StandardTestDispatcher(test.testScheduler)
      )
    val queue =
      ConnectionCommandQueue(
        scope = scope,
        dispatcher = StandardTestDispatcher(test.testScheduler),
        delegate = delegate,
        reply = { requestId, response, routing ->
          if (routing != QueuedReplyRouting.OWNER || requestId in owners) {
            replies += response
            owners.remove(requestId)
          }
        },
        hasRequestOwner = { it in owners },
        logError = { _, error -> failures += error },
        logWarning = { warnings += it },
        logDebug = {},
        capacity = capacity,
      )
    val handler = QueuedWebSocketMessageHandler(delegate, queue)

    fun connection() = ReadLoop(scope, handler, client()) { replies += it }
  }

  @Test
  fun `queued delegate sees its own origin across suspension and restores the thread`() = runTest {
    val held = CompletableDeferred<Unit>()
    val clients = mutableListOf<WebSocketServer.ConnectedClient?>()
    val delegate = FakeHandler { request ->
      clients.add(CommandOriginContext.currentClient())
      assertSame(
        currentCoroutineContext()[CommandOriginContext]?.origin?.client,
        CommandOriginContext.currentClient(),
      )
      if (request.requestId == "first") held.await()
      clients.add(CommandOriginContext.currentClient())
      null
    }
    val fixture = Fixture(this, delegate)
    val first = fixture.connection()
    val second = fixture.connection()
    first.send(RequestHierarchy(requestId = "first"))
    second.send(RequestHierarchy(requestId = "second"))
    runCurrent()
    assertNull(CommandOriginContext.currentClient())
    held.complete(Unit)
    runCurrent()
    assertEquals(listOf(first.client, second.client, second.client, first.client), clients)
    assertNull(CommandOriginContext.currentClient())
  }

  @Test
  fun `queued origin follows a real dispatcher hop and restores both threads`() = runBlocking {
    Executors.newSingleThreadExecutor().asCoroutineDispatcher().use { commandDispatcher ->
      Executors.newSingleThreadExecutor().asCoroutineDispatcher().use { otherDispatcher ->
        val service = Job()
        val lifetime = Job()
        val client = client()
        val finished = CompletableDeferred<Unit>()
        val queue =
          ConnectionCommandQueue(
            scope =
              CoroutineScope(
                service +
                  commandDispatcher +
                  CoroutineExceptionHandler { _, failure ->
                    finished.completeExceptionally(failure)
                  }
              ),
            dispatcher = commandDispatcher,
            delegate =
              FakeHandler {
                assertSame(client, CommandOriginContext.currentClient())
                val commandThread = Thread.currentThread()
                withContext(otherDispatcher) {
                  assertFalse(commandThread === Thread.currentThread())
                  assertSame(client, CommandOriginContext.currentClient())
                }
                assertSame(commandThread, Thread.currentThread())
                assertSame(client, CommandOriginContext.currentClient())
                CorrelatedErrorReporter.frame(it.requestId, "done")
              },
            reply = { _, _, _ -> finished.complete(Unit) },
            hasRequestOwner = { false },
            logError = { _, error -> finished.completeExceptionally(error) },
            logWarning = { finished.completeExceptionally(AssertionError(it)) },
            logDebug = {},
          )
        try {
          withTimeout(1_000) {
            withContext(commandDispatcher) { assertNull(CommandOriginContext.currentClient()) }
            withContext(otherDispatcher) { assertNull(CommandOriginContext.currentClient()) }
            queue.enqueue(FakeOrigin(client, lifetime), RequestHierarchy(requestId = "hop"))
            finished.await()
            service.cancelAndJoin()
            withContext(commandDispatcher) { assertNull(CommandOriginContext.currentClient()) }
            withContext(otherDispatcher) { assertNull(CommandOriginContext.currentClient()) }
            assertNull(CommandOriginContext.currentClient())
          }
        } finally {
          lifetime.cancel()
          withTimeout(1_000) { service.cancelAndJoin() }
        }
      }
    }
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
  fun `busy owned command uses supplied policy even when ownership disappears before rejection`() =
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
      // Fails on base: yes (without an owner snapshot the base broadcasts this as an unowned
      // error).
      // The server's ownership policy remains true even when disconnect clears the owner map.
      fixture.owners.remove("rejected")
      connection.send(
        RequestClipboard(requestId = "rejected", action = "get"),
        ownerRecorded = true,
      )
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
    connection.send(RequestCommitText(requestId = "commit", text = "abcd"), ownerRecorded = true)
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
      fixture.queue.enqueue(FakeOrigin(client(), lifetime), RequestHierarchy(requestId = "pending"))
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
  fun `client key and service shutdown clean up workers without connection shutdown`() = runTest {
    val service = Job()
    val scope = CoroutineScope(service + StandardTestDispatcher(testScheduler))
    val lifetime = Job()
    val calls = mutableListOf<String?>()
    val queue =
      ConnectionCommandQueue(
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
      val finishedClient = client()
      val activeClient = client()
      queue.enqueue(
        FakeOrigin(finishedClient, finishedConnection),
        RequestHierarchy(requestId = "finished"),
      )
      runCurrent()
      finishedConnection.complete()
      runCurrent()
      assertEquals(0, queue.connectionCount)
      queue.enqueue(
        FakeOrigin(finishedClient, finishedConnection),
        RequestHierarchy(requestId = "dropped"),
      )
      assertEquals(0, queue.connectionCount)
      queue.enqueue(FakeOrigin(activeClient, lifetime), RequestHierarchy(requestId = "held"))
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

  // Fails on base: yes (base accepts missing origins and queues by Job instead of failing).
  @Test
  fun `missing origin fails fast rather than bypassing connection ordering`() = runTest {
    val delegate = FakeHandler()
    val fixture = Fixture(this, delegate)
    val failure = runCatching {
      fixture.handler.handleMessage(RequestHierarchy(requestId = "inline"))
    }
      .exceptionOrNull()
    assertTrue(failure is IllegalStateException)
    assertEquals("Queued WebSocket dispatch requires an originating client", failure?.message)
    assertTrue(delegate.calls.isEmpty())
    assertEquals(0, fixture.queue.connectionCount)
  }

  // Fails on base: yes (base has no disconnect hook; its active child only cancels on Job
  // completion).
  @Test
  fun `disconnect immediately cancels in-flight child and drops pending commands`() = runTest {
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
    runCurrent()
    fixture.queue.disconnect(connection.client)
    assertEquals(0, fixture.queue.connectionCount)
    assertTrue(connection.job.isActive)
    runCurrent()
    assertTrue(cancelled.isCompleted)
    assertEquals(listOf("held"), delegate.calls)
    assertTrue(fixture.replies.isEmpty())
    connection.send(RequestHierarchy(requestId = "late"))
    assertEquals(0, fixture.queue.connectionCount)
    assertEquals(listOf("held"), delegate.calls)
  }

  // Fails on base: yes (enqueue snapshots a missing owner as unowned and dispatches it).
  @Test
  fun `owned command whose owner cleared before enqueue is skipped`() = runTest {
    val delegate = FakeHandler()
    val fixture = Fixture(this, delegate)
    val connection = fixture.connection()
    connection.send(
      RequestClipboard(requestId = "disconnected-owner", action = "get"),
      ownerRecorded = true,
    )
    runCurrent()
    assertTrue(delegate.calls.isEmpty())
    assertTrue(fixture.replies.isEmpty())
  }

  // Fails on base: yes (base lacks disconnect and a client liveness tombstone).
  @Test
  fun `disconnect and lifetime completion are idempotent in either order and isolate clients`() =
    runTest {
      val delegate = FakeHandler { awaitCancellation() }
      val fixture = Fixture(this, delegate)
      val first = fixture.connection()
      val second = fixture.connection()
      val healthy = fixture.connection()
      first.send(RequestHierarchy(requestId = "first"))
      second.send(RequestHierarchy(requestId = "second"))
      healthy.send(RequestHierarchy(requestId = "healthy"))
      runCurrent()
      assertEquals(3, fixture.queue.connectionCount)
      fixture.queue.disconnect(first.client)
      fixture.queue.disconnect(first.client)
      first.send(RequestHierarchy(requestId = "late"))
      assertEquals(2, fixture.queue.connectionCount)
      first.job.cancelAndJoin()
      second.job.cancelAndJoin()
      fixture.queue.enqueue(
        FakeOrigin(second.client, Job()),
        RequestHierarchy(requestId = "late-before-hook"),
      )
      assertEquals(1, fixture.queue.connectionCount)
      fixture.queue.disconnect(second.client)
      fixture.queue.disconnect(second.client)
      fixture.queue.enqueue(
        FakeOrigin(second.client, Job()),
        RequestHierarchy(requestId = "late-again"),
      )
      runCurrent()
      assertEquals(1, fixture.queue.connectionCount)
      assertTrue(healthy.job.isActive)
      assertEquals(listOf("first", "second", "healthy"), delegate.calls)
      assertTrue(fixture.replies.isEmpty())
    }
}
