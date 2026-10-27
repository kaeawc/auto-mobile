package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.WebSocketServerIntegrationTestFixtures.Companion.FRAME_TIMEOUT_MS
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.RequestHierarchy
import dev.jasonpearson.automobile.protocol.RequestScreenshot
import dev.jasonpearson.automobile.protocol.SettingsGetResult
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.get
import io.ktor.http.HttpMethod
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Real socket asynchronous results, terminal ownership, and correlated-error isolation. */
@RunWith(RobolectricTestRunner::class)
internal class WebSocketServerIntegrationTestCorrelationTest :
  WebSocketServerIntegrationTestFixtures() {

  @Test
  fun `raw async response drops later orphaned correlated frames`() = runBlocking {
    val rawSuccessServer = rawScreenshotReplyServer()
    startAndWait(rawSuccessServer)
    try {
      val exchange =
        TerminalReplyExchange(
          rawSuccessServer,
          """{"type":"request_screenshot","requestId":"req-raw-success"}""",
        )
      exchange.run(
        afterReply = { rawSuccessServer.broadcast("""{"type":"probe","sequence":1}""") },
        afterUpdates = {
          rawSuccessServer.broadcast(
            ErrorResponse(requestId = "req-raw-success", error = "late correlated failure"),
          )
          rawSuccessServer.broadcast("""{"type":"probe","sequence":2}""")
        },
      )
      assertEquals(
        """{"type":"screenshot","requestId":"req-raw-success"}""",
        exchange.ownerMessages[0],
      )
      assertEquals(
        "a terminal raw response removes ownership, so a late same-ID frame reaches nobody",
        listOf(
          """{"type":"screenshot","requestId":"req-raw-success"}""",
          """{"type":"probe","sequence":1}""",
          """{"type":"probe","sequence":2}""",
        ),
        exchange.ownerMessages.toList(),
      )
      assertEquals(
        "a terminal raw response must not leak a later same-ID frame to another client",
        listOf(
          """{"type":"probe","sequence":1}""",
          """{"type":"probe","sequence":2}""",
        ),
        exchange.bystanderMessages.toList(),
      )
    } finally {
      rawSuccessServer.stop()
    }
  }

  @Test
  fun `typed async response drops later orphaned correlated frames`() = runBlocking {
    val typedSuccessServer = typedScreenshotReplyServer()
    startAndWait(typedSuccessServer)
    try {
      val exchange =
        TerminalReplyExchange(
          typedSuccessServer,
          """{"type":"request_screenshot","requestId":"req-typed-success"}""",
        )
      exchange.run(
        afterReply = { typedSuccessServer.broadcast("""{"type":"probe","sequence":1}""") },
        afterUpdates = {
          typedSuccessServer.broadcast(
            ErrorResponse(requestId = "req-typed-success", error = "late correlated failure"),
          )
          typedSuccessServer.broadcast("""{"type":"probe","sequence":2}""")
        },
      )
      val ownerResult = json.parseToJsonElement(exchange.ownerMessages[0]).jsonObject
      assertEquals("settings_get_result", ownerResult["type"]?.jsonPrimitive?.content)
      assertEquals("req-typed-success", ownerResult["requestId"]?.jsonPrimitive?.content)
      assertEquals(
        "a terminal typed response must drop later same-ID frames",
        listOf(
          """{"type":"probe","sequence":1}""",
          """{"type":"probe","sequence":2}""",
        ),
        exchange.ownerMessages.drop(1),
      )
      assertEquals(
        "a terminal typed response must not leak later same-ID frames to another client",
        listOf(
          """{"type":"probe","sequence":1}""",
          """{"type":"probe","sequence":2}""",
        ),
        exchange.bystanderMessages.toList(),
      )
    } finally {
      typedSuccessServer.stop()
    }
  }

  @Test
  fun `async action failure yields correlated error frame`() = runBlocking {
    // Issue #3023: an action that throws INSIDE its launched coroutine — after the synchronous
    // handleMessage has already returned null — must still yield a correlated type:"error" frame,
    // not leave the daemon awaiter hanging to timeout. This is the async analog of the synchronous
    // handler-throw case covered by `handler exception returns structured error response` (#2985).
    //
    // Scope note: this exercises a *real* AsyncActionRunner end-to-end over a live WebSocket (the
    // fake action routes its fire-and-forget work through it, the same helper CtrlProxy uses). It
    // proves the runner's correlated-error-on-throw contract on the wire; it does NOT instantiate
    // the production CtrlProxy AccessibilityService, so it cannot by itself catch a regression that
    // unwires a specific CtrlProxy launch site from the runner. That production-wiring guard is
    // tracked as a follow-up (a full CtrlProxy service is impractical to drive in a fast unit
    // test).
    lateinit var asyncServer: WebSocketServer
    val runnerHolder = arrayOfNulls<AsyncActionRunner>(1)
    asyncServer =
      WebSocketServer(
        port = 0,
        scope = testScope,
        options =
          WebSocketServerOptions(
            messageHandler =
              CtrlProxyMessageHandler(
                object : NoOpCtrlProxyActions() {
                  override suspend fun requestScreenshot(request: RequestScreenshot) {
                    val requestId = request.requestId

                    // Fire-and-forget: the real work runs in a launched coroutine that throws
                    // after
                    // this method (and handleMessage) has already returned.
                    runnerHolder[0]!!.launch(requestId, "screenshot") {
                      throw IllegalStateException("async boom")
                    }
                  }
                },
              ),
          ),
      )
    runnerHolder[0] =
      AsyncActionRunner(scope = testScope, broadcastResponse = { asyncServer.broadcast(it) })
    startAndWait(asyncServer)
    try {
      val client = HttpClient(CIO) { install(WebSockets) }
      client.use { c ->
        c.webSocket(
          method = HttpMethod.Get,
          host = "localhost",
          port = asyncServer.getActualPort() ?: error("Server not running"),
          path = "/ws",
        ) {
          incoming.receive() // Connection message

          send(Frame.Text("""{"type":"request_screenshot","requestId":"req-async"}"""))

          val responseFrame = withTimeout(1000) { incoming.receive() } as Frame.Text
          val responseJson = json.parseToJsonElement(responseFrame.readText()).jsonObject

          assertEquals("error", responseJson["type"]?.jsonPrimitive?.content)
          assertEquals("req-async", responseJson["requestId"]?.jsonPrimitive?.content)
          assertEquals("false", responseJson["success"]?.jsonPrimitive?.content)
          val error = responseJson["error"]?.jsonPrimitive?.content ?: ""
          assertTrue(
            "error should name the failing action, was: $error",
            error.contains("screenshot"),
          )
        }
      }
    } finally {
      asyncServer.stop()
    }
  }

  @Test
  fun `externally correlated response broadcasts without a socket owner`() = runBlocking {
    startAndWait(server)

    val client = HttpClient(CIO) { install(WebSockets) }
    client.use { c ->
      c.webSocket(
        method = HttpMethod.Get,
        host = "localhost",
        port = getServerPort(),
        path = "/ws",
      ) {
        incoming.receive() // Connection message

        awaitClientsRegistered(server, 1)
        server.broadcastExternallyCorrelatedResponse(
          ErrorResponse(
            timestamp = 1234,
            requestId = "sync_1234_external",
            error = "Hierarchy extraction failed",
          ),
        )

        val responseFrame = withTimeout(FRAME_TIMEOUT_MS) { incoming.receive() } as Frame.Text
        val responseJson = json.parseToJsonElement(responseFrame.readText()).jsonObject
        assertEquals("error", responseJson["type"]?.jsonPrimitive?.content)
        assertEquals("sync_1234_external", responseJson["requestId"]?.jsonPrimitive?.content)
      }
    }
  }

  @Test
  fun `async action failure error response is sent only to originating connection`() = runBlocking {
    lateinit var asyncServer: WebSocketServer
    val runnerHolder = arrayOfNulls<AsyncActionRunner>(1)
    asyncServer =
      WebSocketServer(
        port = 0,
        scope = testScope,
        options =
          WebSocketServerOptions(
            messageHandler =
              CtrlProxyMessageHandler(
                object : NoOpCtrlProxyActions() {
                  override suspend fun requestScreenshot(request: RequestScreenshot) {
                    val requestId = request.requestId

                    runnerHolder[0]!!.launch(requestId, "screenshot") {
                      throw IllegalStateException("async boom")
                    }
                  }
                },
              ),
          ),
      )
    runnerHolder[0] =
      AsyncActionRunner(scope = testScope, broadcastResponse = { asyncServer.broadcast(it) })
    startAndWait(asyncServer)
    try {
      assertErrorTargetsOrigin(
        asyncServer,
        """{"type":"request_screenshot","requestId":"req-async-owner"}""",
        "req-async-owner",
      )
    } finally {
      asyncServer.stop()
    }
  }

  @Test
  fun `hierarchy reply clears owner before a duplicate error`() = runBlocking {
    // Explicit hierarchy replies consume their owner; subsequent unsolicited pushes still reach
    // both clients, while a duplicate correlated error must be dropped (issue #9430).
    val reply = """{"type":"hierarchy_update","requestId":"req-hierarchy","hierarchy":{}}"""
    val hierarchyServer = hierarchyReplyServer(reply)
    startAndWait(hierarchyServer)
    try {
      val exchange =
        TerminalReplyExchange(
          hierarchyServer,
          """{"type":"request_hierarchy","requestId":"req-hierarchy"}""",
        )
      exchange.run(
        afterReply = {},
        afterUpdates = {
          hierarchyServer.broadcast(
            ErrorResponse(requestId = "req-hierarchy", error = "late correlated failure"),
          )
          hierarchyServer.broadcast("""{"type":"probe"}""")
        },
      )
      assertEquals(
        "owner should receive one reply and the unsolicited push, but no duplicate error",
        listOf(
          reply,
          """{"type":"hierarchy_update","hierarchy":{}}""",
          """{"type":"probe"}""",
        ),
        exchange.ownerMessages.toList(),
      )
      assertEquals(
        "the bystander receives only the unsolicited push and probe",
        listOf("""{"type":"hierarchy_update","hierarchy":{}}""", """{"type":"probe"}"""),
        exchange.bystanderMessages.toList(),
      )
    } finally {
      hierarchyServer.stop()
    }
  }

  private fun rawScreenshotReplyServer(): WebSocketServer {
    lateinit var rawSuccessServer: WebSocketServer
    rawSuccessServer =
      WebSocketServer(
        port = 0,
        scope = testScope,
        options =
          WebSocketServerOptions(
            messageHandler =
              CtrlProxyMessageHandler(
                object : NoOpCtrlProxyActions() {
                  override suspend fun requestScreenshot(request: RequestScreenshot) {
                    val requestId = request.requestId

                    testScope.launch {
                      rawSuccessServer.broadcast(
                        """{"type":"screenshot","requestId":"$requestId"}""",
                      )
                    }
                  }
                },
              ),
          ),
      )
    return rawSuccessServer
  }

  private fun typedScreenshotReplyServer(): WebSocketServer {
    lateinit var typedSuccessServer: WebSocketServer
    typedSuccessServer =
      WebSocketServer(
        port = 0,
        scope = testScope,
        options =
          WebSocketServerOptions(
            messageHandler =
              CtrlProxyMessageHandler(
                object : NoOpCtrlProxyActions() {
                  override suspend fun requestScreenshot(request: RequestScreenshot) {
                    val requestId = request.requestId

                    testScope.launch {
                      typedSuccessServer.broadcast(
                        SettingsGetResult(
                          timestamp = 1234L,
                          requestId = requestId,
                          success = true,
                          namespace = "secure",
                          key = "setting",
                          value = "value",
                          found = true,
                          totalTimeMs = 1L,
                        ),
                      )
                    }
                  }
                },
              ),
          ),
      )
    return typedSuccessServer
  }

  private fun hierarchyReplyServer(reply: String): WebSocketServer {
    lateinit var hierarchyServer: WebSocketServer
    hierarchyServer =
      WebSocketServer(
        port = 0,
        scope = testScope,
        options =
          WebSocketServerOptions(
            messageHandler =
              CtrlProxyMessageHandler(
                object : NoOpCtrlProxyActions() {
                  override suspend fun requestHierarchy(request: RequestHierarchy) {
                    // Mirror production: a terminal reply followed by an unsolicited event.
                    testScope.launch {
                      hierarchyServer.broadcastWithPerfSync { reply }
                      hierarchyServer.broadcast("""{"type":"hierarchy_update","hierarchy":{}}""")
                    }
                  }
                },
              ),
          ),
      )
    return hierarchyServer
  }

  private inner class TerminalReplyExchange(
    private val target: WebSocketServer,
    private val command: String,
  ) {
    val ownerMessages: MutableList<String> =
      java.util.Collections.synchronizedList(mutableListOf<String>())
    val bystanderMessages: MutableList<String> =
      java.util.Collections.synchronizedList(mutableListOf<String>())
    private val ownerReady = CompletableDeferred<Unit>()
    private val bystanderReady = CompletableDeferred<Unit>()
    private val sendOwnerMessage = CompletableDeferred<Unit>()
    private val ownerReceivedReply = CompletableDeferred<Unit>()
    private val ownerReceivedUpdate = CompletableDeferred<Unit>()
    private val bystanderReceivedUpdate = CompletableDeferred<Unit>()
    private val readLateSequence = CompletableDeferred<Unit>()

    suspend fun run(afterReply: suspend () -> Unit, afterUpdates: suspend () -> Unit) =
      coroutineScope {
        val ownerClient = HttpClient(CIO) { install(WebSockets) }
        val bystanderClient = HttpClient(CIO) { install(WebSockets) }
        ownerClient.use { owner ->
          bystanderClient.use { bystander ->
            val ownerJob = launch {
              owner.webSocket(
                method = HttpMethod.Get,
                host = "localhost",
                port = target.getActualPort() ?: error("Server not running"),
                path = "/ws",
              ) {
                readOwner()
              }
            }
            val bystanderJob = launch {
              bystander.webSocket(
                method = HttpMethod.Get,
                host = "localhost",
                port = target.getActualPort() ?: error("Server not running"),
                path = "/ws",
              ) {
                readBystander()
              }
            }
            ownerReady.await()
            bystanderReady.await()
            awaitClientsRegistered(target, 2)
            sendOwnerMessage.complete(Unit)
            ownerReceivedReply.await()
            afterReply()
            ownerReceivedUpdate.await()
            bystanderReceivedUpdate.await()
            afterUpdates()
            readLateSequence.complete(Unit)
            ownerJob.join()
            bystanderJob.join()
          }
        }
      }

    private suspend fun DefaultClientWebSocketSession.readOwner() {
      incoming.receive() // Connection message
      ownerReady.complete(Unit)
      sendOwnerMessage.await()
      send(Frame.Text(command))
      ownerMessages.add(receiveText())
      ownerReceivedReply.complete(Unit)
      ownerMessages.add(receiveText())
      ownerReceivedUpdate.complete(Unit)
      readLateSequence.await()
      ownerMessages.add(receiveText())
    }

    private suspend fun DefaultClientWebSocketSession.readBystander() {
      incoming.receive() // Connection message
      bystanderReady.complete(Unit)
      sendOwnerMessage.await()
      bystanderMessages.add(receiveText())
      bystanderReceivedUpdate.complete(Unit)
      readLateSequence.await()
      bystanderMessages.add(receiveText())
    }

    private suspend fun DefaultClientWebSocketSession.receiveText(): String =
      (withTimeout(FRAME_TIMEOUT_MS) { incoming.receive() } as Frame.Text).readText()
  }
}
