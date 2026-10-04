package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.RequestCancelImeCommit
import dev.jasonpearson.automobile.protocol.RequestClipboard
import dev.jasonpearson.automobile.protocol.RequestCommitText
import dev.jasonpearson.automobile.protocol.RequestHierarchy
import dev.jasonpearson.automobile.protocol.SetHierarchyInterval
import dev.jasonpearson.automobile.protocol.WebSocketFrameData
import dev.jasonpearson.automobile.protocol.WebSocketFrameResponse
import dev.jasonpearson.automobile.protocol.WebSocketMessageHandler
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.server.cio.CIO as ServerCIO
import io.ktor.server.engine.embeddedServer
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.util.ReflectionHelpers

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class QueuedWebSocketMessageHandlerIntegrationTest {
  @Test
  fun `real read loops use stable distinct keys and preserve connection order`() = runTest {
    val held = CompletableDeferred<Unit>()
    val started = CompletableDeferred<Unit>()
    val calls = mutableListOf<String?>()
    val delegate =
      object : WebSocketMessageHandler {
        override suspend fun handleMessage(request: WebSocketRequest): WebSocketResponse? {
          calls += request.requestId
          if (request.requestId == "held") {
            started.complete(Unit)
            held.await()
          }
          return CorrelatedErrorReporter.frame(request.requestId, "reply")
        }
      }
    val dispatcher = StandardTestDispatcher(testScheduler)
    val scope = CoroutineScope(backgroundScope.coroutineContext + dispatcher)
    val proxy = Robolectric.buildService(CtrlProxy::class.java).get()
    ReflectionHelpers.getField<CoroutineScope>(proxy, "serviceScope").cancel()
    val queuedHandler = proxy.queuedMessageHandler(delegate, scope, dispatcher)
    val readLoops = ConcurrentHashMap.newKeySet<Job>()
    val server =
      WebSocketServer(
        port = 0,
        scope = scope,
        onClientDisconnected = queuedHandler::disconnect,
        messageHandler =
          handler { request ->
            readLoops +=
              checkNotNull(currentCoroutineContext()[CommandOriginContext]).origin.lifetime
            queuedHandler.handleMessage(request)
          },
      )
    ReflectionHelpers.setField(proxy, "webSocketServer", server)
    val client = HttpClient(CIO) { install(WebSockets) }
    try {
      server.start()
      runCurrent()
      assertTrue(server.isRunning())
      val port = requireNotNull(server.getActualPort())
      val first = client.webSocketSession(urlString = "ws://127.0.0.1:$port/ws")
      val second = client.webSocketSession(urlString = "ws://127.0.0.1:$port/ws")
      try {
        first.incoming.receive() // Greeting precedes command dispatch.
        second.incoming.receive()
        first.send(Frame.Text("""{"type":"request_clipboard","requestId":"held","action":"get"}"""))
        started.await()
        first.send(Frame.Text("""{"type":"request_clipboard","requestId":"next","action":"get"}"""))
        second.send(
          Frame.Text("""{"type":"request_clipboard","requestId":"other","action":"get"}""")
        )
        assertEquals("other", requestId(second.incoming.receive()))
        assertFalse(held.isCompleted)
        assertFalse("second command must wait on its own connection", "next" in calls)
        assertEquals(2, queuedHandler.connectionCount)
        held.complete(Unit)
        assertEquals("held", requestId(first.incoming.receive()))
        assertEquals("next", requestId(first.incoming.receive()))
        assertEquals(listOf("held", "other", "next"), calls)
        assertEquals("same connection must reuse its worker", 2, queuedHandler.connectionCount)
      } finally {
        held.complete(Unit)
        first.close()
        second.close()
        // Join the actual server read loops, rather than polling for asynchronous close delivery.
        readLoops.forEach { it.join() }
        runCurrent()
        assertEquals("closed read loops must remove their queues", 0, queuedHandler.connectionCount)
      }
    } finally {
      held.complete(Unit)
      client.close()
      server.stop()
      runCurrent()
      assertEquals("closed read loops must remove their queues", 0, queuedHandler.connectionCount)
    }
  }

  private class RecordingTransport(private val stalled: Boolean = false) :
    WebSocketServer.ClientTransport {
    val frames = mutableListOf<String>()
    var closeReason: CloseReason? = null

    override suspend fun send(message: String) {
      if (stalled) awaitCancellation()
      frames += message
    }

    override suspend fun close(reason: CloseReason) {
      closeReason = reason
    }
  }

  /** Real service factory/reply routing and server queues, with virtual-time transport fakes. */
  private class RoutingFixture(
    test: TestScope,
    delegate: WebSocketMessageHandler,
    capacity: Int = INBOUND_COMMAND_CAPACITY,
    sendTimeoutMs: Long = WebSocketServer.OUTBOUND_SEND_TIMEOUT_MS,
    stallFirst: Boolean = false,
  ) {
    val dispatcher = StandardTestDispatcher(test.testScheduler)
    val scope = CoroutineScope(test.backgroundScope.coroutineContext + dispatcher)
    val proxy: CtrlProxy = Robolectric.buildService(CtrlProxy::class.java).get()
    val handler = proxy.queuedMessageHandler(delegate, scope, dispatcher, capacity)
    val server =
      WebSocketServer(
        port = 0,
        scope = scope,
        messageHandler = handler,
        sendTimeoutMs = sendTimeoutMs,
        onClientDisconnected = handler::disconnect,
      )
    val first = RecordingTransport(stallFirst)
    val second = RecordingTransport()
    val owner: WebSocketServer.ConnectedClient

    init {
      ReflectionHelpers.getField<CoroutineScope>(proxy, "serviceScope").cancel()
      ReflectionHelpers.setField(proxy, "webSocketServer", server)
      // isRunning checks engine presence. This unstarted marker opens no socket and launches no
      // engine jobs; real routing/senders operate solely on the registered transport fakes.
      ReflectionHelpers.setField(server, "server", embeddedServer(ServerCIO, port = 0) {})
      owner = server.registerClient(1, first)
      server.registerClient(2, second)
    }

    suspend fun dispatch(request: WebSocketRequest) {
      server.handleClientMessage(Json.encodeToString(WebSocketRequest.serializer(), request), owner)
    }

    fun close() {
      server.unregisterClient(owner)
      ReflectionHelpers.setField(server, "server", null)
      server.stop()
    }
  }

  private fun handler(body: suspend (WebSocketRequest) -> WebSocketResponse?) =
    object : WebSocketMessageHandler {
      override suspend fun handleMessage(request: WebSocketRequest) = body(request)
    }

  // Fails on base: yes (new immediate removal assertion fails while its read-loop Job is active).
  @Test
  fun `owned pending command is skipped after disconnect while read loop remains active`() =
    runTest {
      val held = CompletableDeferred<Unit>()
      val calls = mutableListOf<String?>()
      val fixture =
        RoutingFixture(
          this,
          handler { request ->
            calls += request.requestId
            if (request.requestId == "held") held.await()
            CorrelatedErrorReporter.frame(request.requestId, "reply")
          },
        )
      fixture.server.registerRequestOwner("pending", fixture.owner)
      val loop = backgroundScope.launch {
        fixture.dispatch(RequestHierarchy(requestId = "held"))
        fixture.dispatch(RequestClipboard(requestId = "pending", action = "get"))
        awaitCancellation()
      }
      try {
        runCurrent()
        assertEquals(listOf("held"), calls)
        fixture.server.unregisterClient(fixture.owner)
        assertEquals(0, fixture.handler.connectionCount)
        assertTrue(loop.isActive)
        held.complete(Unit)
        runCurrent()
        assertEquals(listOf("held"), calls)
        assertTrue(fixture.second.frames.isEmpty())
      } finally {
        held.complete(Unit)
        loop.cancelAndJoin()
        fixture.close()
      }
    }

  @Test
  fun `owned handler that replies then throws cannot leak its fallback error`() = runTest {
    lateinit var fixture: RoutingFixture
    fixture =
      RoutingFixture(
        this,
        handler { request ->
          fixture.server.broadcast(
            CorrelatedErrorReporter.frame(request.requestId, "terminal reply")
          )
          throw IllegalStateException("after reply")
        },
      )
    fixture.server.registerRequestOwner("answered", fixture.owner)
    try {
      fixture.dispatch(RequestClipboard(requestId = "answered", action = "get"))
      runCurrent()
      assertEquals(1, fixture.first.frames.size)
      assertTrue(fixture.first.frames.single().contains("terminal reply"))
      assertTrue(fixture.second.frames.isEmpty())
      assertFalse(fixture.server.hasRequestOwner("answered"))
    } finally {
      fixture.close()
    }
  }

  @Test
  fun `owned running command reply is dropped after its owner disconnects`() = runTest {
    val held = CompletableDeferred<Unit>()
    val fixture =
      RoutingFixture(
        this,
        handler { request ->
          held.await()
          CorrelatedErrorReporter.frame(request.requestId, "returned result")
        },
      )
    fixture.server.registerRequestOwner("running", fixture.owner)
    try {
      fixture.dispatch(RequestClipboard(requestId = "running", action = "get"))
      runCurrent()
      fixture.server.unregisterClient(fixture.owner)
      assertTrue(coroutineContext[Job]!!.isActive)
      held.complete(Unit)
      runCurrent()
      assertTrue(fixture.first.frames.isEmpty())
      assertTrue(fixture.second.frames.isEmpty())
    } finally {
      held.complete(Unit)
      fixture.close()
    }
  }

  @Test
  fun `non-null unowned delegate result retains ordinary broadcast routing`() = runTest {
    val fixture =
      RoutingFixture(
        this,
        handler { request ->
          CorrelatedErrorReporter.frame(request.requestId, "returned result")
        },
      )
    try {
      fixture.dispatch(SetHierarchyInterval(requestId = "hierarchy"))
      runCurrent()
      // Inline broadcast(response) drops an orphaned correlation, even for an unowned type.
      assertTrue(fixture.first.frames.isEmpty())
      assertTrue(fixture.second.frames.isEmpty())
    } finally {
      fixture.close()
    }
  }

  @Test
  fun `unowned handler error reaches only its originating client`() = runTest {
    val fixture = RoutingFixture(this, handler { throw IllegalStateException("hierarchy failed") })
    try {
      fixture.dispatch(SetHierarchyInterval(requestId = "hierarchy"))
      runCurrent()
      // Fails on base: yes (EXTERNAL_ERROR broadcasts the failure to both clients).
      assertEquals(1, fixture.first.frames.size)
      assertTrue(fixture.second.frames.isEmpty())
      assertTrue(fixture.first.frames.single().contains("Handler error: hierarchy failed"))
    } finally {
      fixture.close()
    }
  }

  @Test
  fun `cancel leaves active commit alive so its single result retains partial application counts`() =
    runTest {
      val finishCommit = CompletableDeferred<Unit>()
      var cancelSeen = false
      var commitFinished = false
      lateinit var fixture: RoutingFixture
      fixture =
        RoutingFixture(
          this,
          handler { request ->
            when (request) {
              is RequestCommitText -> {
                finishCommit.await()
                commitFinished = true
                fixture.server.broadcast(
                  buildJsonObject {
                    put("type", "commit_text_result")
                    put("requestId", request.requestId)
                    put("timestamp", 0)
                    put("success", false)
                    put("error", "IME commit cancelled")
                    put("partialApplication", true)
                    put("committedUnits", 2)
                  }
                    .toString()
                )
              }
              is RequestCancelImeCommit -> cancelSeen = true
              else -> error("Unexpected request")
            }
            null
          },
        )
      fixture.server.registerRequestOwner("commit", fixture.owner)
      try {
        fixture.dispatch(RequestCommitText(requestId = "commit", text = "abcd"))
        runCurrent()
        fixture.dispatch(RequestCancelImeCommit(targetRequestId = "commit"))
        runCurrent()
        assertTrue(cancelSeen)
        assertFalse(commitFinished)
        assertTrue(fixture.first.frames.isEmpty())
        assertTrue(fixture.server.hasRequestOwner("commit"))
        finishCommit.complete(Unit)
        runCurrent()
        assertTrue(commitFinished)
        val result = Json.parseToJsonElement(fixture.first.frames.single()).jsonObject
        assertEquals("commit_text_result", result.getValue("type").jsonPrimitive.content)
        assertEquals("IME commit cancelled", result.getValue("error").jsonPrimitive.content)
        assertEquals("true", result.getValue("partialApplication").jsonPrimitive.content)
        assertEquals("2", result.getValue("committedUnits").jsonPrimitive.content)
        assertTrue(fixture.second.frames.isEmpty())
        assertTrue(fixture.first.frames.none { it.contains("Command cancelled") })
      } finally {
        finishCommit.complete(Unit)
        fixture.close()
      }
    }

  @Test
  fun `detached commit cancellation bypasses slow unrelated command and preserves its result`() =
    runTest {
      val finishCommit = CompletableDeferred<Unit>()
      val slow = CompletableDeferred<Unit>()
      var cancelSeen = false
      val slowStarted = CompletableDeferred<Unit>()
      var slowFinished = false
      lateinit var fixture: RoutingFixture
      fixture =
        RoutingFixture(
          this,
          handler { request ->
            when {
              request is RequestCommitText ->
                fixture.scope.launch {
                  finishCommit.await()
                  check(cancelSeen)
                  fixture.server.broadcast(
                    buildJsonObject {
                      put("type", "commit_text_result")
                      put("requestId", request.requestId)
                      put("timestamp", 0)
                      put("success", false)
                      put("error", "IME commit cancelled")
                      put("partialApplication", true)
                      put("committedUnits", 2)
                    }
                      .toString()
                  )
                }
              request is RequestCancelImeCommit -> cancelSeen = true
              request.requestId == "slow" -> {
                slowStarted.complete(Unit)
                slow.await()
                slowFinished = true
              }
              else -> error("Unexpected request")
            }
            null
          },
        )
      fixture.server.registerRequestOwner("commit", fixture.owner)
      val loop = backgroundScope.launch {
        fixture.dispatch(RequestCommitText(requestId = "commit", text = "abcd"))
        fixture.dispatch(RequestHierarchy(requestId = "slow"))
        slowStarted.await()
        fixture.dispatch(RequestCancelImeCommit(targetRequestId = "commit"))
        awaitCancellation()
      }
      try {
        runCurrent()
        assertTrue(cancelSeen)
        assertTrue(slowStarted.isCompleted)
        assertFalse(slowFinished)
        assertTrue(fixture.first.frames.isEmpty())
        finishCommit.complete(Unit)
        runCurrent()
        val result = Json.parseToJsonElement(fixture.first.frames.single()).jsonObject
        assertEquals("commit_text_result", result.getValue("type").jsonPrimitive.content)
        assertEquals("IME commit cancelled", result.getValue("error").jsonPrimitive.content)
        assertEquals("true", result.getValue("partialApplication").jsonPrimitive.content)
        assertEquals("2", result.getValue("committedUnits").jsonPrimitive.content)
        assertTrue(fixture.second.frames.isEmpty())
        slow.complete(Unit)
        runCurrent()
        assertTrue(slowFinished)
        assertEquals(1, fixture.first.frames.size)
        assertTrue(fixture.first.frames.none { it.contains("Command cancelled") })
      } finally {
        finishCommit.complete(Unit)
        slow.complete(Unit)
        loop.cancelAndJoin()
        fixture.close()
      }
    }

  private class LoopbackFixture(
    test: TestScope,
    delegate: WebSocketMessageHandler,
    capacity: Int,
  ) {
    private val dispatcher = StandardTestDispatcher(test.testScheduler)
    private val scope = CoroutineScope(test.backgroundScope.coroutineContext + dispatcher)
    private val proxy = Robolectric.buildService(CtrlProxy::class.java).get()
    val queued = proxy.queuedMessageHandler(delegate, scope, dispatcher, capacity)
    val accepted = Channel<String?>(Channel.UNLIMITED)
    private val loops = ConcurrentHashMap.newKeySet<Job>()
    val server =
      WebSocketServer(
        port = 0,
        scope = scope,
        onClientDisconnected = queued::disconnect,
        messageHandler =
          object : WebSocketMessageHandler {
            override suspend fun handleMessage(request: WebSocketRequest): WebSocketResponse? {
              val origin = checkNotNull(currentCoroutineContext()[CommandOriginContext]).origin
              loops += origin.lifetime
              val response = queued.handleMessage(request)
              accepted.trySend(request.requestId)
              return response
            }
          },
      )
    val client = HttpClient(CIO) { install(WebSockets) }
    lateinit var first: DefaultClientWebSocketSession
    lateinit var second: DefaultClientWebSocketSession

    init {
      ReflectionHelpers.getField<CoroutineScope>(proxy, "serviceScope").cancel()
      ReflectionHelpers.setField(proxy, "webSocketServer", server)
    }

    suspend fun connect() {
      val port = requireNotNull(server.getActualPort())
      first = client.webSocketSession(urlString = "ws://127.0.0.1:$port/ws")
      second = client.webSocketSession(urlString = "ws://127.0.0.1:$port/ws")
      first.incoming.receive()
      second.incoming.receive()
    }

    suspend fun close() {
      if (::first.isInitialized) first.close()
      if (::second.isInitialized) second.close()
      loops.forEach { it.join() }
      client.close()
      server.stop()
    }
  }

  private suspend fun TestScope.withLoopbackClients(
    delegate: WebSocketMessageHandler,
    capacity: Int = INBOUND_COMMAND_CAPACITY,
    body: suspend (LoopbackFixture) -> Unit,
  ) {
    val fixture = LoopbackFixture(this, delegate, capacity)
    try {
      fixture.server.start()
      runCurrent()
      fixture.connect()
      body(fixture)
    } finally {
      fixture.close()
      runCurrent()
    }
  }

  private suspend fun send(
    session: DefaultClientWebSocketSession,
    request: WebSocketRequest,
  ) = session.send(Frame.Text(Json.encodeToString(WebSocketRequest.serializer(), request)))

  // Fails on base: yes (EXTERNAL_ERROR broadcasts the unowned throw before the second client's
  // barrier).
  @Test
  fun `loopback unowned handler failure targets origin and leaves peer stream clean`() = runTest {
    withLoopbackClients(
      handler { request ->
        if (request is SetHierarchyInterval) error("hierarchy failed")
        CorrelatedErrorReporter.frame(request.requestId, "barrier")
      }
    ) { fixture ->
      send(fixture.first, SetHierarchyInterval(requestId = "failure"))
      val failure = fixture.first.incoming.receive() as Frame.Text
      assertEquals("failure", requestId(failure))
      assertTrue(failure.readText().contains("Handler error: hierarchy failed"))
      send(fixture.second, RequestClipboard(requestId = "barrier", action = "get"))
      assertEquals("barrier", requestId(fixture.second.incoming.receive()))
      assertTrue(fixture.second.incoming.tryReceive().isFailure)
      assertTrue(fixture.first.incoming.tryReceive().isFailure)
    }
  }

  @Test
  fun `owned hierarchy queue full rejection targets requester and releases owner`() = runTest {
    val held = CompletableDeferred<Unit>()
    val fixture =
      RoutingFixture(
        this,
        handler { request ->
          if (request.requestId == "held") held.await()
          CorrelatedErrorReporter.frame(request.requestId, "reply")
        },
        capacity = 1,
      )
    try {
      fixture.dispatch(RequestHierarchy(requestId = "held"))
      runCurrent()
      fixture.dispatch(RequestHierarchy(requestId = "pending"))
      fixture.dispatch(RequestHierarchy(requestId = "rejected"))
      runCurrent()
      assertEquals(1, fixture.first.frames.size)
      assertEquals("rejected", WebSocketServer.extractRequestId(fixture.first.frames.single()))
      assertTrue(fixture.first.frames.single().contains("ctrlproxy_busy"))
      assertTrue(fixture.second.frames.isEmpty())
      assertFalse(fixture.server.hasRequestOwner("rejected"))
      assertTrue(fixture.server.hasRequestOwner("held"))
      assertTrue(fixture.server.hasRequestOwner("pending"))
      held.complete(Unit)
      runCurrent()
      assertFalse(fixture.server.hasRequestOwner("held"))
      assertFalse(fixture.server.hasRequestOwner("pending"))
      assertTrue(fixture.second.frames.isEmpty())
    } finally {
      held.complete(Unit)
      fixture.close()
    }
  }

  // Fails on base: yes (EXTERNAL_ERROR broadcasts the unowned busy rejection to the peer).
  @Test
  fun `loopback unowned queue full rejection targets origin only`() = runTest {
    val held = CompletableDeferred<Unit>()
    val started = CompletableDeferred<Unit>()
    try {
      withLoopbackClients(
        handler { request ->
          if (request.requestId == "held") {
            started.complete(Unit)
            held.await()
          }
          if (request is RequestClipboard)
            CorrelatedErrorReporter.frame(request.requestId, "barrier")
          else null
        },
        capacity = 1,
      ) { fixture ->
        send(fixture.first, SetHierarchyInterval(requestId = "held"))
        started.await()
        assertEquals("held", fixture.accepted.receive())
        send(fixture.first, SetHierarchyInterval(requestId = "pending"))
        assertEquals("pending", fixture.accepted.receive())
        send(fixture.first, SetHierarchyInterval(requestId = "rejected"))
        val rejection = fixture.first.incoming.receive() as Frame.Text
        assertEquals("rejected", requestId(rejection))
        assertTrue(rejection.readText().contains("ctrlproxy_busy"))
        send(fixture.second, RequestClipboard(requestId = "barrier", action = "get"))
        assertEquals("barrier", requestId(fixture.second.incoming.receive()))
        assertTrue(fixture.second.incoming.tryReceive().isFailure)
        held.complete(Unit)
      }
    } finally {
      held.complete(Unit)
    }
  }

  // Fails on base: no (owned errors and uncorrelated successful results already follow these
  // rules).
  @Test
  fun `loopback owned errors stay targeted and successful unowned results broadcast`() = runTest {
    val event =
      WebSocketFrameResponse(
        timestamp = 0,
        event =
          WebSocketFrameData(
            connectionId = "socket",
            url = "ws://example",
            direction = "in",
            frameType = "text",
          ),
      )
    withLoopbackClients(
      handler { request ->
        if (request is RequestClipboard) error("owned failure")
        event
      }
    ) { fixture ->
      send(fixture.first, RequestClipboard(requestId = "owned", action = "get"))
      val failure = fixture.first.incoming.receive() as Frame.Text
      assertEquals("owned", requestId(failure))
      assertTrue(failure.readText().contains("Handler error: owned failure"))
      send(fixture.first, RequestHierarchy(requestId = "hierarchy"))
      val firstEvent = (fixture.first.incoming.receive() as Frame.Text).readText()
      val peerEvent = (fixture.second.incoming.receive() as Frame.Text).readText()
      assertEquals(firstEvent, peerEvent)
      assertTrue(peerEvent.contains("websocket_frame_event"))
      assertTrue(fixture.second.incoming.tryReceive().isFailure)
    }
  }

  // Fails on base: yes (unowned pending commands continue while the read-loop Job is active).
  @Test
  fun `outbound timeout cancels unowned queue immediately while read loop stays active`() =
    runTest {
      val cancelled = CompletableDeferred<Unit>()
      val calls = mutableListOf<String?>()
      val fixture =
        RoutingFixture(
          this,
          handler { request ->
            calls += request.requestId
            try {
              awaitCancellation()
            } finally {
              cancelled.complete(Unit)
            }
          },
          sendTimeoutMs = 100,
          stallFirst = true,
        )
      val loop = backgroundScope.launch {
        fixture.dispatch(RequestHierarchy(requestId = "held"))
        fixture.dispatch(RequestHierarchy(requestId = "pending"))
        awaitCancellation()
      }
      try {
        runCurrent()
        assertEquals(1, fixture.handler.connectionCount)
        fixture.server.sendToClient(fixture.owner, "trigger-timeout")
        runCurrent()
        advanceTimeBy(100)
        runCurrent()
        assertEquals("Outbound send timed out", fixture.first.closeReason?.message)
        assertTrue(loop.isActive)
        assertEquals(0, fixture.handler.connectionCount)
        assertTrue(cancelled.isCompleted)
        assertEquals(listOf("held"), calls)
        fixture.dispatch(RequestHierarchy(requestId = "late"))
        fixture.dispatch(RequestClipboard(requestId = "late-owned", action = "get"))
        assertFalse(fixture.server.hasRequestOwner("late-owned"))
        runCurrent()
        assertEquals(0, fixture.handler.connectionCount)
        assertEquals(listOf("held"), calls)
        fixture.server.unregisterClient(fixture.owner)
        fixture.handler.disconnect(fixture.owner)
        assertEquals(0, fixture.handler.connectionCount)
        assertEquals(1, fixture.server.getConnectionCount())
        assertTrue(fixture.second.frames.isEmpty())
      } finally {
        loop.cancelAndJoin()
        fixture.close()
      }
    }

  private fun requestId(frame: Frame): String? {
    require(frame is Frame.Text)
    return Json.parseToJsonElement(frame.readText()).jsonObject["requestId"]?.jsonPrimitive?.content
  }
}
