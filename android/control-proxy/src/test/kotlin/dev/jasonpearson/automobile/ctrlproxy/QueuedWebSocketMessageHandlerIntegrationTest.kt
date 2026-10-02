package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.RequestCancelImeCommit
import dev.jasonpearson.automobile.protocol.RequestClipboard
import dev.jasonpearson.automobile.protocol.RequestCommitText
import dev.jasonpearson.automobile.protocol.RequestHierarchy
import dev.jasonpearson.automobile.protocol.WebSocketMessageHandler
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
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
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
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
        messageHandler =
          handler { request ->
            readLoops += currentCoroutineContext().job
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

  private class RecordingTransport : WebSocketServer.ClientTransport {
    val frames = mutableListOf<String>()

    override suspend fun send(message: String) {
      frames += message
    }

    override suspend fun close(reason: CloseReason) = Unit
  }

  /** Real service factory/reply routing and server queues, with virtual-time transport fakes. */
  private class RoutingFixture(test: TestScope, delegate: WebSocketMessageHandler) {
    val dispatcher = StandardTestDispatcher(test.testScheduler)
    val scope = CoroutineScope(test.backgroundScope.coroutineContext + dispatcher)
    val proxy: CtrlProxy = Robolectric.buildService(CtrlProxy::class.java).get()
    val handler = proxy.queuedMessageHandler(delegate, scope, dispatcher)
    val server = WebSocketServer(port = 0, scope = scope, messageHandler = handler)
    val first = RecordingTransport()
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

    fun close() {
      ReflectionHelpers.setField(server, "server", null)
      server.stop()
    }
  }

  private fun handler(body: suspend (WebSocketRequest) -> WebSocketResponse?) =
    object : WebSocketMessageHandler {
      override suspend fun handleMessage(request: WebSocketRequest) = body(request)
    }

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
        fixture.handler.handleMessage(RequestHierarchy(requestId = "held"))
        fixture.handler.handleMessage(RequestClipboard(requestId = "pending", action = "get"))
        awaitCancellation()
      }
      try {
        runCurrent()
        assertEquals(listOf("held"), calls)
        fixture.server.unregisterClient(fixture.owner)
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
      fixture.handler.handleMessage(RequestClipboard(requestId = "answered", action = "get"))
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
      fixture.handler.handleMessage(RequestClipboard(requestId = "running", action = "get"))
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
      fixture.handler.handleMessage(RequestHierarchy(requestId = "hierarchy"))
      runCurrent()
      // Inline broadcast(response) drops an orphaned correlation, even for an unowned type.
      assertTrue(fixture.first.frames.isEmpty())
      assertTrue(fixture.second.frames.isEmpty())
    } finally {
      fixture.close()
    }
  }

  @Test
  fun `unowned handler error uses documented external broadcast fallback`() = runTest {
    val fixture = RoutingFixture(this, handler { throw IllegalStateException("hierarchy failed") })
    try {
      fixture.handler.handleMessage(RequestHierarchy(requestId = "hierarchy"))
      runCurrent()
      // Follow-up: pass the originating ConnectedClient into dispatch and use sendErrorResponse
      // for unowned errors/busy replies. Until then this fallback intentionally reaches A and B.
      assertEquals(1, fixture.first.frames.size)
      assertEquals(fixture.first.frames, fixture.second.frames)
      assertTrue(fixture.second.frames.single().contains("Handler error: hierarchy failed"))
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
        fixture.handler.handleMessage(RequestCommitText(requestId = "commit", text = "abcd"))
        runCurrent()
        fixture.handler.handleMessage(RequestCancelImeCommit(targetRequestId = "commit"))
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
        fixture.handler.handleMessage(RequestCommitText(requestId = "commit", text = "abcd"))
        fixture.handler.handleMessage(RequestHierarchy(requestId = "slow"))
        slowStarted.await()
        fixture.handler.handleMessage(RequestCancelImeCommit(targetRequestId = "commit"))
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

  private fun requestId(frame: Frame): String? {
    require(frame is Frame.Text)
    return Json.parseToJsonElement(frame.readText()).jsonObject["requestId"]?.jsonPrimitive?.content
  }
}
