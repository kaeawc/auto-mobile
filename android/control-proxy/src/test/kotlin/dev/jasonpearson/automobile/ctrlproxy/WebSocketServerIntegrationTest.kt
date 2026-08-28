package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ElementBounds
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.ctrlproxy.models.UIElementInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.SettingsGetResult
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.get
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Integration tests for WebSocketServer with actual network I/O. These tests verify real WebSocket
 * connections and message broadcasting.
 *
 * Note: These tests use runBlocking instead of runTest to allow actual network operations. They may
 * be slower than pure unit tests but provide confidence that the WebSocket server works correctly.
 */
@RunWith(RobolectricTestRunner::class)
class WebSocketServerIntegrationTest {

  private lateinit var server: WebSocketServer
  private lateinit var testScope: CoroutineScope
  private val json = Json { ignoreUnknownKeys = true }

  @Before
  fun setUp() {
    testScope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    // Use port 0 to let OS assign an available port, avoiding conflicts when tests run in parallel
    server =
      WebSocketServer(
        port = 0,
        scope = testScope,
        messageHandler =
          CtrlProxyMessageHandler(
            object : NoOpCtrlProxyActions() {
              override fun addHighlight(
                requestId: String?,
                highlightId: String?,
                shape: HighlightShape?,
              ) {
                val error =
                  when {
                    highlightId.isNullOrBlank() -> "Missing highlight id"
                    shape == null -> "Missing highlight shape"
                    else -> null
                  }
                enqueueHighlightResponse(requestId, error == null, error)
              }
            }
          ),
      )
  }

  /** Get the actual port the server is listening on. Must be called after server.start(). */
  private fun getServerPort(): Int {
    return server.getActualPort() ?: error("Server not running or port not available")
  }

  @After
  fun tearDown() {
    if (server.isRunning()) {
      server.stop()
    }
    testScope.cancel()
    // Minimal cleanup time
    Thread.sleep(50)
  }

  /**
   * Wait for a condition to be true with exponential backoff. Much faster than fixed delays when
   * condition becomes true quickly.
   */
  private suspend fun waitFor(
    timeoutMs: Long = 1000,
    checkIntervalMs: Long = 10,
    condition: () -> Boolean,
  ) {
    withTimeout(timeoutMs) {
      while (!condition()) {
        delay(checkIntervalMs)
      }
    }
  }

  private fun enqueueHighlightResponse(
    requestId: String?,
    success: Boolean,
    error: String?,
  ) {
    val errorJson = json.encodeToString<String?>(error)
    val message = buildString {
      append("""{"type":"highlight_response","timestamp":${System.currentTimeMillis()}""")
      if (requestId != null) {
        append(""","requestId":"$requestId"""")
      }
      append(""","success":$success""")
      append(""","error":$errorJson""")
      append("}")
    }

    testScope.launch { server.broadcast(message) }
  }

  @Test
  fun `server starts and stops successfully`() = runBlocking {
    // When
    server.start()

    // Then
    assertTrue("Server should be running", server.isRunning())

    // When - stop server
    server.stop()

    // Then
    assertFalse("Server should be stopped", server.isRunning())
  }

  @Test
  fun `server does not start twice`() = runBlocking {
    // Given
    server.start()

    // When - try to start again
    server.start()

    // Then - should still be running normally
    assertTrue("Server should still be running", server.isRunning())
  }

  @Test
  fun `client can connect to server`() = runBlocking {
    // Given
    server.start()
    val firstClientConnection = async { server.awaitFirstClientConnection() }

    assertFalse("No client should be ready before the handshake", firstClientConnection.isCompleted)

    // When
    val client = HttpClient(CIO) { install(WebSockets) }

    client.use { client ->
      client.webSocket(
        method = HttpMethod.Get,
        host = "localhost",
        port = getServerPort(),
        path = "/ws",
      ) {
        // Then - connection established
        waitFor { server.getConnectionCount() == 1 }
        withTimeout(1000) { firstClientConnection.await() }
        assertEquals(1, server.getConnectionCount())

        // Receive connection message
        val frame = withTimeout(1000) { incoming.receive() }
        if (frame is Frame.Text) {
          val message = frame.readText()
          assertTrue("Should receive connection message", message.contains("connected"))
        }
      }
    }

    // Wait for cleanup using condition-based waiting
    waitFor { server.getConnectionCount() == 0 }
    assertEquals("Connection should be cleaned up", 0, server.getConnectionCount())
  }

  @Test
  fun `observerSessionGeneration is stable within a session and advances after it empties`() =
    runBlocking {
      // The scroll-staleness fix (issue #5470) keys "is this the same observer session" on
      // observerSessionGeneration, which must advance ONLY on the empty->non-empty edge:
      //  - stable while >= 1 client stays continuously connected (so a concurrent 2nd client
      // joining
      //    does NOT reset a still-connected client's in-flight scroll),
      //  - advanced after the set empties and a new client connects (so a disconnect+reconnect,
      //    including one with no intervening event, correctly clears stale scroll deltas).
      server.start()
      assertEquals(
        "generation starts at 0 before any connection",
        0,
        server.observerSessionGeneration(),
      )

      val client1 = HttpClient(CIO) { install(WebSockets) }
      val client2 = HttpClient(CIO) { install(WebSockets) }
      client1.use { c1 ->
        c1.webSocket(
          method = HttpMethod.Get,
          host = "localhost",
          port = getServerPort(),
          path = "/ws",
        ) {
          waitFor { server.getConnectionCount() == 1 }
          val genAfterFirst = server.observerSessionGeneration()
          assertEquals("generation advances on the first client of a session", 1, genAfterFirst)

          // A SECOND concurrent client joins (1 -> 2): the generation must NOT change.
          client2.use { c2 ->
            c2.webSocket(
              method = HttpMethod.Get,
              host = "localhost",
              port = getServerPort(),
              path = "/ws",
            ) {
              waitFor { server.getConnectionCount() == 2 }
              assertEquals(
                "a concurrent 2nd client must not change the generation",
                genAfterFirst,
                server.observerSessionGeneration(),
              )
            }
          }
          // Second client gone; first still connected — still the same session.
          waitFor { server.getConnectionCount() == 1 }
          assertEquals(
            "generation is stable while a client stays connected",
            genAfterFirst,
            server.observerSessionGeneration(),
          )
        }
      }

      // The set has now emptied. A new client starts a new session: generation must advance.
      waitFor { server.getConnectionCount() == 0 }
      val genAfterEmpty = server.observerSessionGeneration()
      val client3 = HttpClient(CIO) { install(WebSockets) }
      client3.use { c3 ->
        c3.webSocket(
          method = HttpMethod.Get,
          host = "localhost",
          port = getServerPort(),
          path = "/ws",
        ) {
          waitFor { server.getConnectionCount() == 1 }
          assertEquals(
            "live count cannot distinguish the reconnect",
            1,
            server.getConnectionCount(),
          )
          assertTrue(
            "generation must advance after the set empties (was $genAfterEmpty, now ${server.observerSessionGeneration()})",
            server.observerSessionGeneration() > genAfterEmpty,
          )
        }
      }
      waitFor { server.getConnectionCount() == 0 }
    }

  @Test
  fun `server broadcasts messages to connected client`() = runBlocking {
    // Given
    server.start()

    val receivedMessages = mutableListOf<String>()
    val client = HttpClient(CIO) { install(WebSockets) }

    client.use { client ->
      val job = launch {
        client.webSocket(
          method = HttpMethod.Get,
          host = "localhost",
          port = getServerPort(),
          path = "/ws",
        ) {
          // Receive and discard connection message
          incoming.receive()

          // Listen for broadcast messages with timeout
          var messageCount = 0
          for (frame in incoming) {
            if (frame is Frame.Text) {
              receivedMessages.add(frame.readText())
              messageCount++
              break
            }
          }
        }
      }

      // Wait for connection
      waitFor { server.getConnectionCount() == 1 }

      // When - broadcast a message
      val testMessage = """{"type":"test","data":"Hello WebSocket"}"""
      server.broadcast(testMessage)

      // Wait for message to be received
      waitFor { receivedMessages.size >= 1 }

      // Then
      assertEquals("Should receive 1 broadcast message", 1, receivedMessages.size)
      assertEquals(testMessage, receivedMessages[0])

      job.cancel()
    }
  }

  @Test
  fun `server broadcasts hierarchy updates with correct format`() = runBlocking {
    // Given
    server.start()

    val receivedMessages = mutableListOf<String>()
    val client = HttpClient(CIO) { install(WebSockets) }

    client.use { client ->
      val job = launch {
        client.webSocket(
          method = HttpMethod.Get,
          host = "localhost",
          port = getServerPort(),
          path = "/ws",
        ) {
          incoming.receive() // Discard connection message
          var messageCount = 0
          for (frame in incoming) {
            if (frame is Frame.Text) {
              receivedMessages.add(frame.readText())
              messageCount++
              break
            }
          }
        }
      }

      // Wait for connection
      waitFor { server.getConnectionCount() == 1 }

      // When - create and broadcast a hierarchy update
      val hierarchy =
        ViewHierarchy(
          packageName = "com.example.app",
          hierarchy =
            UIElementInfo(
              text = "Hello",
              clickable = "true",
              bounds = ElementBounds(0, 0, 100, 50),
            ),
        )

      val hierarchyJson = json.encodeToString(ViewHierarchy.serializer(), hierarchy)
      val message =
        """{"type":"hierarchy_update","timestamp":${System.currentTimeMillis()},"data":$hierarchyJson}"""
      server.broadcast(message)

      // Wait for message to be received
      waitFor { receivedMessages.isNotEmpty() }

      // Then - verify message format
      assertEquals("Should receive 1 message", 1, receivedMessages.size)

      val receivedMessage = receivedMessages[0]
      val messageJson = json.parseToJsonElement(receivedMessage).jsonObject

      assertEquals("hierarchy_update", messageJson["type"]?.jsonPrimitive?.content)
      assertNotNull("Should have timestamp", messageJson["timestamp"])
      assertNotNull("Should have data", messageJson["data"])

      // Verify the data contains the hierarchy
      val dataJson = messageJson["data"]?.jsonObject
      assertEquals("com.example.app", dataJson?.get("packageName")?.jsonPrimitive?.content)

      job.cancel()
    }
  }

  @Test
  fun `health check endpoint responds correctly`() = runBlocking {
    // Given
    server.start()

    // When
    val client = HttpClient(CIO)
    client.use { client ->
      val response = client.get("http://localhost:${getServerPort()}/health")

      // Then
      assertEquals("Health check should return OK", HttpStatusCode.OK, response.status)
    }
  }

  @Test
  fun `server handles client disconnection gracefully`() = runBlocking {
    // Given
    server.start()

    val client = HttpClient(CIO) { install(WebSockets) }

    client.use { client ->
      val job = launch {
        client.webSocket(
          method = HttpMethod.Get,
          host = "localhost",
          port = getServerPort(),
          path = "/ws",
        ) {
          incoming.receive() // Connection message
          delay(10)
          // Connection will be closed when coroutine ends
        }
      }

      waitFor { server.getConnectionCount() == 1 }
      assertEquals("Should have 1 connection", 1, server.getConnectionCount())

      // When - client disconnects
      job.cancel()
      waitFor { server.getConnectionCount() == 0 }

      // Then - connection should be cleaned up
      assertEquals("Connection should be cleaned up", 0, server.getConnectionCount())
    }
  }

  @Test
  fun `await client connection waits for a replacement client after disconnect`() = runBlocking {
    server.start()

    val client = HttpClient(CIO) { install(WebSockets) }
    client.use { client ->
      val firstClient = launch {
        client.webSocket(
          method = HttpMethod.Get,
          host = "localhost",
          port = getServerPort(),
          path = "/ws",
        ) {
          incoming.receive()
          delay(Long.MAX_VALUE)
        }
      }

      waitFor { server.getConnectionCount() == 1 }
      withTimeout(1000) { server.awaitClientConnection() }

      firstClient.cancel()
      firstClient.join()
      waitFor { server.getConnectionCount() == 0 }

      val reconnectWait = async { server.awaitClientConnection() }
      assertFalse(
        "A disconnected client must not satisfy the delivery gate",
        reconnectWait.isCompleted,
      )

      val replacementClient = launch {
        client.webSocket(
          method = HttpMethod.Get,
          host = "localhost",
          port = getServerPort(),
          path = "/ws",
        ) {
          incoming.receive()
          delay(Long.MAX_VALUE)
        }
      }

      waitFor { server.getConnectionCount() == 1 }
      withTimeout(1000) { reconnectWait.await() }

      replacementClient.cancel()
      replacementClient.join()
    }
  }

  @Test
  fun `sync broadcast waits for a client and delivers after it connects`() = runBlocking {
    server.start()
    val response =
      SettingsGetResult(
        timestamp = 1234L,
        success = true,
        namespace = "secure",
        key = "setting",
        value = "value",
        found = true,
        totalTimeMs = 1L,
      )
    val delivery = async {
      server.broadcast(
        response,
        mode = WebSocketServer.BroadcastMode.Sync,
        waitForClient = true,
      )
    }
    assertFalse("Delivery must wait until a client is connected", delivery.isCompleted)

    val client = HttpClient(CIO) { install(WebSockets) }
    client.use { client ->
      client.webSocket(
        method = HttpMethod.Get,
        host = "localhost",
        port = getServerPort(),
        path = "/ws",
      ) {
        incoming.receive()
        val delivered = withTimeout(1000) { incoming.receive() } as Frame.Text
        val payload = json.parseToJsonElement(delivered.readText()).jsonObject

        assertEquals("settings_get_result", payload["type"]?.jsonPrimitive?.content)
        withTimeout(1000) { delivery.await() }
      }
    }
  }

  @Test
  fun `add_highlight returns highlight response`() = runBlocking {
    server.start()

    val client = HttpClient(CIO) { install(WebSockets) }
    client.use { client ->
      client.webSocket(
        method = HttpMethod.Get,
        host = "localhost",
        port = getServerPort(),
        path = "/ws",
      ) {
        incoming.receive() // Connection message

        val requestId = "req-add"
        val message =
          """{"type":"add_highlight","requestId":"$requestId","id":"highlight-1","shape":{"type":"box","bounds":{"x":10,"y":20,"width":100,"height":80},"style":{"strokeColor":"#FF0000","strokeWidth":4,"dashPattern":null}}}"""
        send(Frame.Text(message))

        val responseFrame = withTimeout(1000) { incoming.receive() } as Frame.Text
        val responseJson = json.parseToJsonElement(responseFrame.readText()).jsonObject

        assertEquals("highlight_response", responseJson["type"]?.jsonPrimitive?.content)
        assertEquals(requestId, responseJson["requestId"]?.jsonPrimitive?.content)
        assertEquals("true", responseJson["success"]?.jsonPrimitive?.content)
        assertEquals("null", responseJson["error"]?.toString())
      }
    }
  }

  @Test
  fun `add_path_highlight returns highlight response`() = runBlocking {
    server.start()

    val client = HttpClient(CIO) { install(WebSockets) }
    client.use { client ->
      client.webSocket(
        method = HttpMethod.Get,
        host = "localhost",
        port = getServerPort(),
        path = "/ws",
      ) {
        incoming.receive() // Connection message

        val requestId = "req-add-path"
        val message =
          """{"type":"add_highlight","requestId":"$requestId","id":"path-1","shape":{"type":"path","points":[{"x":10,"y":20},{"x":40,"y":35},{"x":80,"y":25}],"style":{"strokeColor":"#FF8800","strokeWidth":5,"smoothing":"catmull-rom","tension":0.6}}}"""
        send(Frame.Text(message))

        val responseFrame = withTimeout(1000) { incoming.receive() } as Frame.Text
        val responseJson = json.parseToJsonElement(responseFrame.readText()).jsonObject

        assertEquals("highlight_response", responseJson["type"]?.jsonPrimitive?.content)
        assertEquals(requestId, responseJson["requestId"]?.jsonPrimitive?.content)
        assertEquals("true", responseJson["success"]?.jsonPrimitive?.content)
      }
    }
  }

  @Test
  fun `invalid add_highlight returns error response`() = runBlocking {
    server.start()

    val client = HttpClient(CIO) { install(WebSockets) }
    client.use { client ->
      client.webSocket(
        method = HttpMethod.Get,
        host = "localhost",
        port = getServerPort(),
        path = "/ws",
      ) {
        incoming.receive() // Connection message

        val requestId = "req-invalid"
        val message =
          """{"type":"add_highlight","requestId":"$requestId","shape":{"type":"box","bounds":{"x":10,"y":20,"width":100,"height":80},"style":{"strokeColor":"#FF0000","strokeWidth":4,"dashPattern":null}}}"""
        send(Frame.Text(message))

        val responseFrame = withTimeout(1000) { incoming.receive() } as Frame.Text
        val responseJson = json.parseToJsonElement(responseFrame.readText()).jsonObject

        assertEquals("highlight_response", responseJson["type"]?.jsonPrimitive?.content)
        assertEquals(requestId, responseJson["requestId"]?.jsonPrimitive?.content)
        assertEquals("false", responseJson["success"]?.jsonPrimitive?.content)
        assertEquals("Missing highlight id", responseJson["error"]?.jsonPrimitive?.content)
      }
    }
  }

  @Test
  fun `malformed command returns structured error response`() = runBlocking {
    // Issue #2985: an inbound command that fails to decode (here, an unknown command type) must
    // produce a structured `type:"error"` frame correlated by requestId, not a silent return that
    // leaves the daemon awaiter hanging until timeout.
    server.start()

    val client = HttpClient(CIO) { install(WebSockets) }
    client.use { client ->
      client.webSocket(
        method = HttpMethod.Get,
        host = "localhost",
        port = getServerPort(),
        path = "/ws",
      ) {
        incoming.receive() // Connection message

        send(Frame.Text("""{"type":"totally_unknown_command","requestId":"req-bad"}"""))

        val responseFrame = withTimeout(1000) { incoming.receive() } as Frame.Text
        val responseJson = json.parseToJsonElement(responseFrame.readText()).jsonObject

        assertEquals("error", responseJson["type"]?.jsonPrimitive?.content)
        assertEquals("req-bad", responseJson["requestId"]?.jsonPrimitive?.content)
        assertEquals("false", responseJson["success"]?.jsonPrimitive?.content)
        val error = responseJson["error"]?.jsonPrimitive?.content ?: ""
        assertTrue("error message should be non-empty", error.isNotEmpty())
        // Proves the legibility mapping fires on the *real* kotlinx decode exception (not just a
        // synthetic one): an unknown command type names the offending type on the wire.
        assertTrue(
          "expected the unknown type to be named, was: $error",
          error.contains("totally_unknown_command"),
        )
      }
    }
  }

  @Test
  fun `out of range numeric literal returns legible structured error response`() = runBlocking {
    // Issue #3022: exercise the real kotlinx decode path with an out-of-range literal instead of a
    // synthetic exception, so Android proves parity with the iOS decode-boundary legibility case.
    server.start()

    val client = HttpClient(CIO) { install(WebSockets) }
    client.use { client ->
      client.webSocket(
        method = HttpMethod.Get,
        host = "localhost",
        port = getServerPort(),
        path = "/ws",
      ) {
        incoming.receive() // Connection message

        send(
          Frame.Text(
            """{"type":"request_tap_coordinates","requestId":"req-out-of-range","x":1e309,"y":10}"""
          )
        )

        val responseFrame = withTimeout(1000) { incoming.receive() } as Frame.Text
        val responseJson = json.parseToJsonElement(responseFrame.readText()).jsonObject

        assertEquals("error", responseJson["type"]?.jsonPrimitive?.content)
        assertEquals("req-out-of-range", responseJson["requestId"]?.jsonPrimitive?.content)
        assertEquals("false", responseJson["success"]?.jsonPrimitive?.content)
        val error = responseJson["error"]?.jsonPrimitive?.content ?: ""
        assertTrue("error message should be non-empty", error.isNotEmpty())
        assertTrue(
          "expected the out-of-range numeric failure to be legible, was: $error",
          error.contains("numeric value is out of range", ignoreCase = true) ||
            error.contains("not representable", ignoreCase = true),
        )
      }
    }
  }

  @Test
  fun `decode error response is sent only to originating connection`() = runBlocking {
    // Issue #3022: decode-boundary errors are request/connection scoped. Broadcast events and
    // normal
    // responses still fan out, but an unrelated client should not observe another client's parse
    // failure.
    server.start()

    val ownerMessages = java.util.Collections.synchronizedList(mutableListOf<String>())
    val bystanderMessages = java.util.Collections.synchronizedList(mutableListOf<String>())
    val ownerReady = kotlinx.coroutines.CompletableDeferred<Unit>()
    val bystanderReady = kotlinx.coroutines.CompletableDeferred<Unit>()
    val sendOwnerMessage = kotlinx.coroutines.CompletableDeferred<Unit>()
    val bystanderCheckedErrorWindow = kotlinx.coroutines.CompletableDeferred<Unit>()
    val sendProbeBroadcast = kotlinx.coroutines.CompletableDeferred<Unit>()

    val ownerClient = HttpClient(CIO) { install(WebSockets) }
    val bystanderClient = HttpClient(CIO) { install(WebSockets) }
    ownerClient.use { owner ->
      bystanderClient.use { bystander ->
        val ownerJob = launch {
          owner.webSocket(
            method = HttpMethod.Get,
            host = "localhost",
            port = getServerPort(),
            path = "/ws",
          ) {
            incoming.receive() // Connection message
            ownerReady.complete(Unit)
            sendOwnerMessage.await()
            send(Frame.Text("""{"type":"totally_unknown_command","requestId":"req-owner"}"""))
            val responseFrame = withTimeout(1000) { incoming.receive() } as Frame.Text
            ownerMessages.add(responseFrame.readText())
          }
        }

        val bystanderJob = launch {
          bystander.webSocket(
            method = HttpMethod.Get,
            host = "localhost",
            port = getServerPort(),
            path = "/ws",
          ) {
            incoming.receive() // Connection message
            bystanderReady.complete(Unit)
            sendOwnerMessage.await()
            val responseFrame = withTimeoutOrNull(250) { incoming.receive() }
            if (responseFrame is Frame.Text) {
              bystanderMessages.add(responseFrame.readText())
            }
            bystanderCheckedErrorWindow.complete(Unit)
            sendProbeBroadcast.await()
            val probeFrame = withTimeout(1000) { incoming.receive() } as Frame.Text
            bystanderMessages.add(probeFrame.readText())
          }
        }

        ownerReady.await()
        bystanderReady.await()
        sendOwnerMessage.complete(Unit)
        ownerJob.join()
        bystanderCheckedErrorWindow.await()
        server.broadcast("""{"type":"probe"}""")
        sendProbeBroadcast.complete(Unit)
        bystanderJob.join()

        assertEquals("originating client should receive one error frame", 1, ownerMessages.size)
        val ownerJson = json.parseToJsonElement(ownerMessages.single()).jsonObject
        assertEquals("error", ownerJson["type"]?.jsonPrimitive?.content)
        assertEquals("req-owner", ownerJson["requestId"]?.jsonPrimitive?.content)
        assertEquals(
          "unrelated client should receive only the liveness probe, not another connection's error",
          listOf("""{"type":"probe"}"""),
          bystanderMessages.toList(),
        )
      }
    }
  }

  @Test
  fun `unparseable payload returns error response with null requestId`() = runBlocking {
    // Best-effort requestId extraction (#2985): when the payload can't be parsed at all, the error
    // frame is still emitted with a null requestId rather than swallowed.
    server.start()

    val client = HttpClient(CIO) { install(WebSockets) }
    client.use { client ->
      client.webSocket(
        method = HttpMethod.Get,
        host = "localhost",
        port = getServerPort(),
        path = "/ws",
      ) {
        incoming.receive() // Connection message

        send(Frame.Text("""{"type":"request_screenshot", this is not json"""))

        val responseFrame = withTimeout(1000) { incoming.receive() } as Frame.Text
        val responseJson = json.parseToJsonElement(responseFrame.readText()).jsonObject

        assertEquals("error", responseJson["type"]?.jsonPrimitive?.content)
        assertEquals(kotlinx.serialization.json.JsonNull, responseJson["requestId"])
        assertEquals("false", responseJson["success"]?.jsonPrimitive?.content)
      }
    }
  }

  @Test
  fun `handler exception returns structured error response`() = runBlocking {
    // Issue #2985: a handler that throws while processing a well-formed command must still yield a
    // structured error frame correlated by requestId, not just a server-side log line.
    val throwingServer =
      WebSocketServer(
        port = 0,
        scope = testScope,
        messageHandler =
          CtrlProxyMessageHandler(
            object : NoOpCtrlProxyActions() {
              override fun requestScreenshot(requestId: String?) {
                throw RuntimeException("kaboom")
              }
            }
          ),
      )
    throwingServer.start()
    try {
      val client = HttpClient(CIO) { install(WebSockets) }
      client.use { client ->
        client.webSocket(
          method = HttpMethod.Get,
          host = "localhost",
          port = throwingServer.getActualPort() ?: error("Server not running"),
          path = "/ws",
        ) {
          incoming.receive() // Connection message

          send(Frame.Text("""{"type":"request_screenshot","requestId":"req-throw"}"""))

          val responseFrame = withTimeout(1000) { incoming.receive() } as Frame.Text
          val responseJson = json.parseToJsonElement(responseFrame.readText()).jsonObject

          assertEquals("error", responseJson["type"]?.jsonPrimitive?.content)
          assertEquals("req-throw", responseJson["requestId"]?.jsonPrimitive?.content)
          assertEquals("false", responseJson["success"]?.jsonPrimitive?.content)
          val error = responseJson["error"]?.jsonPrimitive?.content ?: ""
          assertTrue("error message should be non-empty", error.isNotEmpty())
        }
      }
    } finally {
      throwingServer.stop()
    }
  }

  @Test
  fun `handler exception error response is sent only to originating connection`() = runBlocking {
    val throwingServer =
      WebSocketServer(
        port = 0,
        scope = testScope,
        messageHandler =
          CtrlProxyMessageHandler(
            object : NoOpCtrlProxyActions() {
              override fun requestScreenshot(requestId: String?) {
                throw RuntimeException("kaboom")
              }
            }
          ),
      )
    throwingServer.start()
    try {
      val ownerMessages = java.util.Collections.synchronizedList(mutableListOf<String>())
      val bystanderMessages = java.util.Collections.synchronizedList(mutableListOf<String>())
      val ownerReady = kotlinx.coroutines.CompletableDeferred<Unit>()
      val bystanderReady = kotlinx.coroutines.CompletableDeferred<Unit>()
      val sendOwnerMessage = kotlinx.coroutines.CompletableDeferred<Unit>()
      val bystanderCheckedErrorWindow = kotlinx.coroutines.CompletableDeferred<Unit>()
      val sendProbeBroadcast = kotlinx.coroutines.CompletableDeferred<Unit>()

      val ownerClient = HttpClient(CIO) { install(WebSockets) }
      val bystanderClient = HttpClient(CIO) { install(WebSockets) }
      ownerClient.use { owner ->
        bystanderClient.use { bystander ->
          val ownerJob = launch {
            owner.webSocket(
              method = HttpMethod.Get,
              host = "localhost",
              port = throwingServer.getActualPort() ?: error("Server not running"),
              path = "/ws",
            ) {
              incoming.receive() // Connection message
              ownerReady.complete(Unit)
              sendOwnerMessage.await()
              send(Frame.Text("""{"type":"request_screenshot","requestId":"req-throw-owner"}"""))
              val responseFrame = withTimeout(1000) { incoming.receive() } as Frame.Text
              ownerMessages.add(responseFrame.readText())
            }
          }

          val bystanderJob = launch {
            bystander.webSocket(
              method = HttpMethod.Get,
              host = "localhost",
              port = throwingServer.getActualPort() ?: error("Server not running"),
              path = "/ws",
            ) {
              incoming.receive() // Connection message
              bystanderReady.complete(Unit)
              sendOwnerMessage.await()
              val responseFrame = withTimeoutOrNull(250) { incoming.receive() }
              if (responseFrame is Frame.Text) {
                bystanderMessages.add(responseFrame.readText())
              }
              bystanderCheckedErrorWindow.complete(Unit)
              sendProbeBroadcast.await()
              val probeFrame = withTimeout(1000) { incoming.receive() } as Frame.Text
              bystanderMessages.add(probeFrame.readText())
            }
          }

          ownerReady.await()
          bystanderReady.await()
          sendOwnerMessage.complete(Unit)
          ownerJob.join()
          bystanderCheckedErrorWindow.await()
          throwingServer.broadcast("""{"type":"probe"}""")
          sendProbeBroadcast.complete(Unit)
          bystanderJob.join()

          assertEquals("originating client should receive one error frame", 1, ownerMessages.size)
          val ownerJson = json.parseToJsonElement(ownerMessages.single()).jsonObject
          assertEquals("error", ownerJson["type"]?.jsonPrimitive?.content)
          assertEquals("req-throw-owner", ownerJson["requestId"]?.jsonPrimitive?.content)
          assertEquals(
            "unrelated client should receive only the liveness probe, not another connection's error",
            listOf("""{"type":"probe"}"""),
            bystanderMessages.toList(),
          )
        }
      }
    } finally {
      throwingServer.stop()
    }
  }

  @Test
  fun `commands dispatch in wire order`() = runBlocking {
    // Regression guard for message ordering: two synchronous commands sent back-to-back must run
    // in the order they arrive on the wire. This holds only because the server dispatches inline on
    // the read loop; if dispatch were launched into a background scope, these could reorder.
    val order = java.util.Collections.synchronizedList(mutableListOf<String>())
    val orderedServer =
      WebSocketServer(
        port = 0,
        scope = testScope,
        messageHandler =
          CtrlProxyMessageHandler(
            object : NoOpCtrlProxyActions() {
              override fun setRecompositionTracking(enabled: Boolean) {
                order.add("flags")
              }

              override fun requestScreenshot(requestId: String?) {
                order.add("screenshot")
              }
            }
          ),
      )
    orderedServer.start()
    try {
      val client = HttpClient(CIO) { install(WebSockets) }
      client.use { c ->
        c.webSocket(
          method = HttpMethod.Get,
          host = "localhost",
          port = orderedServer.getActualPort() ?: error("Server not running"),
          path = "/ws",
        ) {
          incoming.receive() // connection greeting
          send(Frame.Text("""{"type":"set_recomposition_tracking","enabled":true}"""))
          send(Frame.Text("""{"type":"request_screenshot","requestId":"s1"}"""))
          withTimeout(1000) {
            while (order.size < 2) {
              delay(10)
            }
          }
          assertEquals(listOf("flags", "screenshot"), order.toList())
        }
      }
    } finally {
      orderedServer.stop()
    }
  }

  @Test
  fun `raw async response drops later orphaned correlated frames`() = runBlocking {
    lateinit var rawSuccessServer: WebSocketServer
    rawSuccessServer =
      WebSocketServer(
        port = 0,
        scope = testScope,
        messageHandler =
          CtrlProxyMessageHandler(
            object : NoOpCtrlProxyActions() {
              override fun requestScreenshot(requestId: String?) {
                testScope.launch {
                  rawSuccessServer.broadcast("""{"type":"screenshot","requestId":"$requestId"}""")
                }
              }
            }
          ),
      )
    rawSuccessServer.start()
    try {
      val ownerMessages = java.util.Collections.synchronizedList(mutableListOf<String>())
      val bystanderMessages = java.util.Collections.synchronizedList(mutableListOf<String>())
      val ownerReady = kotlinx.coroutines.CompletableDeferred<Unit>()
      val bystanderReady = kotlinx.coroutines.CompletableDeferred<Unit>()
      val sendOwnerMessage = kotlinx.coroutines.CompletableDeferred<Unit>()
      val ownerReceivedRaw = kotlinx.coroutines.CompletableDeferred<Unit>()
      val ownerReceivedProbe = kotlinx.coroutines.CompletableDeferred<Unit>()
      val bystanderReceivedProbe = kotlinx.coroutines.CompletableDeferred<Unit>()
      val readLateSequence = kotlinx.coroutines.CompletableDeferred<Unit>()

      val ownerClient = HttpClient(CIO) { install(WebSockets) }
      val bystanderClient = HttpClient(CIO) { install(WebSockets) }
      ownerClient.use { owner ->
        bystanderClient.use { bystander ->
          val ownerJob = launch {
            owner.webSocket(
              method = HttpMethod.Get,
              host = "localhost",
              port = rawSuccessServer.getActualPort() ?: error("Server not running"),
              path = "/ws",
            ) {
              incoming.receive() // Connection message
              ownerReady.complete(Unit)
              sendOwnerMessage.await()
              send(Frame.Text("""{"type":"request_screenshot","requestId":"req-raw-success"}"""))
              ownerMessages.add((withTimeout(1000) { incoming.receive() } as Frame.Text).readText())
              ownerReceivedRaw.complete(Unit)
              ownerMessages.add((withTimeout(1000) { incoming.receive() } as Frame.Text).readText())
              ownerReceivedProbe.complete(Unit)
              readLateSequence.await()
              ownerMessages.add((withTimeout(1000) { incoming.receive() } as Frame.Text).readText())
            }
          }

          val bystanderJob = launch {
            bystander.webSocket(
              method = HttpMethod.Get,
              host = "localhost",
              port = rawSuccessServer.getActualPort() ?: error("Server not running"),
              path = "/ws",
            ) {
              incoming.receive() // Connection message
              bystanderReady.complete(Unit)
              sendOwnerMessage.await()
              bystanderMessages.add(
                (withTimeout(1000) { incoming.receive() } as Frame.Text).readText()
              )
              bystanderReceivedProbe.complete(Unit)
              readLateSequence.await()
              bystanderMessages.add(
                (withTimeout(1000) { incoming.receive() } as Frame.Text).readText()
              )
            }
          }

          ownerReady.await()
          bystanderReady.await()
          sendOwnerMessage.complete(Unit)
          ownerReceivedRaw.await()
          rawSuccessServer.broadcast("""{"type":"probe","sequence":1}""")
          ownerReceivedProbe.await()
          bystanderReceivedProbe.await()
          rawSuccessServer.broadcast(
            ErrorResponse(requestId = "req-raw-success", error = "late correlated failure")
          )
          rawSuccessServer.broadcast("""{"type":"probe","sequence":2}""")
          readLateSequence.complete(Unit)
          ownerJob.join()
          bystanderJob.join()

          assertEquals("""{"type":"screenshot","requestId":"req-raw-success"}""", ownerMessages[0])
          assertEquals(
            "a terminal raw response removes ownership, so a late same-ID frame reaches nobody",
            listOf(
              """{"type":"screenshot","requestId":"req-raw-success"}""",
              """{"type":"probe","sequence":1}""",
              """{"type":"probe","sequence":2}""",
            ),
            ownerMessages.toList(),
          )
          assertEquals(
            "a terminal raw response must not leak a later same-ID frame to another client",
            listOf(
              """{"type":"probe","sequence":1}""",
              """{"type":"probe","sequence":2}""",
            ),
            bystanderMessages.toList(),
          )
        }
      }
    } finally {
      rawSuccessServer.stop()
    }
  }

  @Test
  fun `typed async response drops later orphaned correlated frames`() = runBlocking {
    lateinit var typedSuccessServer: WebSocketServer
    typedSuccessServer =
      WebSocketServer(
        port = 0,
        scope = testScope,
        messageHandler =
          CtrlProxyMessageHandler(
            object : NoOpCtrlProxyActions() {
              override fun requestScreenshot(requestId: String?) {
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
                    )
                  )
                }
              }
            }
          ),
      )
    typedSuccessServer.start()
    try {
      val ownerMessages = java.util.Collections.synchronizedList(mutableListOf<String>())
      val bystanderMessages = java.util.Collections.synchronizedList(mutableListOf<String>())
      val ownerReady = kotlinx.coroutines.CompletableDeferred<Unit>()
      val bystanderReady = kotlinx.coroutines.CompletableDeferred<Unit>()
      val sendOwnerMessage = kotlinx.coroutines.CompletableDeferred<Unit>()
      val ownerReceivedTyped = kotlinx.coroutines.CompletableDeferred<Unit>()
      val ownerReceivedProbe = kotlinx.coroutines.CompletableDeferred<Unit>()
      val bystanderReceivedProbe = kotlinx.coroutines.CompletableDeferred<Unit>()
      val readLateSequence = kotlinx.coroutines.CompletableDeferred<Unit>()

      val ownerClient = HttpClient(CIO) { install(WebSockets) }
      val bystanderClient = HttpClient(CIO) { install(WebSockets) }
      ownerClient.use { owner ->
        bystanderClient.use { bystander ->
          val ownerJob = launch {
            owner.webSocket(
              method = HttpMethod.Get,
              host = "localhost",
              port = typedSuccessServer.getActualPort() ?: error("Server not running"),
              path = "/ws",
            ) {
              incoming.receive() // Connection message
              ownerReady.complete(Unit)
              sendOwnerMessage.await()
              send(Frame.Text("""{"type":"request_screenshot","requestId":"req-typed-success"}"""))
              ownerMessages.add((withTimeout(1000) { incoming.receive() } as Frame.Text).readText())
              ownerReceivedTyped.complete(Unit)
              ownerMessages.add((withTimeout(1000) { incoming.receive() } as Frame.Text).readText())
              ownerReceivedProbe.complete(Unit)
              readLateSequence.await()
              ownerMessages.add((withTimeout(1000) { incoming.receive() } as Frame.Text).readText())
            }
          }

          val bystanderJob = launch {
            bystander.webSocket(
              method = HttpMethod.Get,
              host = "localhost",
              port = typedSuccessServer.getActualPort() ?: error("Server not running"),
              path = "/ws",
            ) {
              incoming.receive() // Connection message
              bystanderReady.complete(Unit)
              sendOwnerMessage.await()
              bystanderMessages.add(
                (withTimeout(1000) { incoming.receive() } as Frame.Text).readText()
              )
              bystanderReceivedProbe.complete(Unit)
              readLateSequence.await()
              bystanderMessages.add(
                (withTimeout(1000) { incoming.receive() } as Frame.Text).readText()
              )
            }
          }

          ownerReady.await()
          bystanderReady.await()
          sendOwnerMessage.complete(Unit)
          ownerReceivedTyped.await()
          typedSuccessServer.broadcast("""{"type":"probe","sequence":1}""")
          ownerReceivedProbe.await()
          bystanderReceivedProbe.await()
          typedSuccessServer.broadcast(
            ErrorResponse(requestId = "req-typed-success", error = "late correlated failure")
          )
          typedSuccessServer.broadcast("""{"type":"probe","sequence":2}""")
          readLateSequence.complete(Unit)
          ownerJob.join()
          bystanderJob.join()

          val ownerResult = json.parseToJsonElement(ownerMessages[0]).jsonObject
          assertEquals("settings_get_result", ownerResult["type"]?.jsonPrimitive?.content)
          assertEquals("req-typed-success", ownerResult["requestId"]?.jsonPrimitive?.content)
          assertEquals(
            "a terminal typed response must drop later same-ID frames",
            listOf(
              """{"type":"probe","sequence":1}""",
              """{"type":"probe","sequence":2}""",
            ),
            ownerMessages.drop(1),
          )
          assertEquals(
            "a terminal typed response must not leak later same-ID frames to another client",
            listOf(
              """{"type":"probe","sequence":1}""",
              """{"type":"probe","sequence":2}""",
            ),
            bystanderMessages.toList(),
          )
        }
      }
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
        messageHandler =
          CtrlProxyMessageHandler(
            object : NoOpCtrlProxyActions() {
              override fun requestScreenshot(requestId: String?) {
                // Fire-and-forget: the real work runs in a launched coroutine that throws
                // after
                // this method (and handleMessage) has already returned.
                runnerHolder[0]!!.launch(requestId, "screenshot") {
                  throw RuntimeException("async boom")
                }
              }
            }
          ),
      )
    runnerHolder[0] =
      AsyncActionRunner(scope = testScope, broadcastResponse = { asyncServer.broadcast(it) })
    asyncServer.start()
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
    server.start()

    val client = HttpClient(CIO) { install(WebSockets) }
    client.use { c ->
      c.webSocket(
        method = HttpMethod.Get,
        host = "localhost",
        port = getServerPort(),
        path = "/ws",
      ) {
        incoming.receive() // Connection message

        server.broadcastExternallyCorrelatedResponse(
          ErrorResponse(
            timestamp = 1234,
            requestId = "sync_1234_external",
            error = "Hierarchy extraction failed",
          )
        )

        val responseFrame = withTimeout(1000) { incoming.receive() } as Frame.Text
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
        messageHandler =
          CtrlProxyMessageHandler(
            object : NoOpCtrlProxyActions() {
              override fun requestScreenshot(requestId: String?) {
                runnerHolder[0]!!.launch(requestId, "screenshot") {
                  throw RuntimeException("async boom")
                }
              }
            }
          ),
      )
    runnerHolder[0] =
      AsyncActionRunner(scope = testScope, broadcastResponse = { asyncServer.broadcast(it) })
    asyncServer.start()
    try {
      val ownerMessages = java.util.Collections.synchronizedList(mutableListOf<String>())
      val bystanderMessages = java.util.Collections.synchronizedList(mutableListOf<String>())
      val ownerReady = kotlinx.coroutines.CompletableDeferred<Unit>()
      val bystanderReady = kotlinx.coroutines.CompletableDeferred<Unit>()
      val sendOwnerMessage = kotlinx.coroutines.CompletableDeferred<Unit>()
      val bystanderCheckedErrorWindow = kotlinx.coroutines.CompletableDeferred<Unit>()
      val sendProbeBroadcast = kotlinx.coroutines.CompletableDeferred<Unit>()

      val ownerClient = HttpClient(CIO) { install(WebSockets) }
      val bystanderClient = HttpClient(CIO) { install(WebSockets) }
      ownerClient.use { owner ->
        bystanderClient.use { bystander ->
          val ownerJob = launch {
            owner.webSocket(
              method = HttpMethod.Get,
              host = "localhost",
              port = asyncServer.getActualPort() ?: error("Server not running"),
              path = "/ws",
            ) {
              incoming.receive() // Connection message
              ownerReady.complete(Unit)
              sendOwnerMessage.await()
              send(Frame.Text("""{"type":"request_screenshot","requestId":"req-async-owner"}"""))
              val responseFrame = withTimeout(1000) { incoming.receive() } as Frame.Text
              ownerMessages.add(responseFrame.readText())
            }
          }

          val bystanderJob = launch {
            bystander.webSocket(
              method = HttpMethod.Get,
              host = "localhost",
              port = asyncServer.getActualPort() ?: error("Server not running"),
              path = "/ws",
            ) {
              incoming.receive() // Connection message
              bystanderReady.complete(Unit)
              sendOwnerMessage.await()
              val responseFrame = withTimeoutOrNull(250) { incoming.receive() }
              if (responseFrame is Frame.Text) {
                bystanderMessages.add(responseFrame.readText())
              }
              bystanderCheckedErrorWindow.complete(Unit)
              sendProbeBroadcast.await()
              val probeFrame = withTimeout(1000) { incoming.receive() } as Frame.Text
              bystanderMessages.add(probeFrame.readText())
            }
          }

          ownerReady.await()
          bystanderReady.await()
          sendOwnerMessage.complete(Unit)
          ownerJob.join()
          bystanderCheckedErrorWindow.await()
          asyncServer.broadcast("""{"type":"probe"}""")
          sendProbeBroadcast.complete(Unit)
          bystanderJob.join()

          assertEquals("originating client should receive one error frame", 1, ownerMessages.size)
          val ownerJson = json.parseToJsonElement(ownerMessages.single()).jsonObject
          assertEquals("error", ownerJson["type"]?.jsonPrimitive?.content)
          assertEquals("req-async-owner", ownerJson["requestId"]?.jsonPrimitive?.content)
          assertEquals(
            "unrelated client should receive only the liveness probe, not another connection's error",
            listOf("""{"type":"probe"}"""),
            bystanderMessages.toList(),
          )
        }
      }
    } finally {
      asyncServer.stop()
    }
  }

  @Test
  fun `uncorrelated hierarchy success drops an unrelated later correlated frame`() = runBlocking {
    // Issue #3190 (follow-up to #3159): a request_hierarchy carrying a requestId completes with an
    // uncorrelated success — the action broadcasts a `hierarchy_update` frame that has NO requestId
    // (production: CtrlProxy.kt broadcasts via HierarchyDebouncer without threading the requestId
    // through). Because that frame cannot clear an owner entry, the server must NOT record one in
    // the first place. A later correlated frame has no owner and must be dropped rather than
    // leaked to every connected observer.
    lateinit var hierarchyServer: WebSocketServer
    hierarchyServer =
      WebSocketServer(
        port = 0,
        scope = testScope,
        messageHandler =
          CtrlProxyMessageHandler(
            object : NoOpCtrlProxyActions() {
              override fun requestHierarchy(disableAllFiltering: Boolean) {
                // Mirror production: success broadcasts a hierarchy_update with no requestId.
                testScope.launch {
                  hierarchyServer.broadcast("""{"type":"hierarchy_update","hierarchy":{}}""")
                }
              }
            }
          ),
      )
    hierarchyServer.start()
    try {
      val ownerMessages = java.util.Collections.synchronizedList(mutableListOf<String>())
      val bystanderMessages = java.util.Collections.synchronizedList(mutableListOf<String>())
      val ownerReady = kotlinx.coroutines.CompletableDeferred<Unit>()
      val bystanderReady = kotlinx.coroutines.CompletableDeferred<Unit>()
      val sendOwnerMessage = kotlinx.coroutines.CompletableDeferred<Unit>()
      val ownerReceivedUpdate = kotlinx.coroutines.CompletableDeferred<Unit>()
      val bystanderReceivedUpdate = kotlinx.coroutines.CompletableDeferred<Unit>()
      val readLateSequence = kotlinx.coroutines.CompletableDeferred<Unit>()

      val ownerClient = HttpClient(CIO) { install(WebSockets) }
      val bystanderClient = HttpClient(CIO) { install(WebSockets) }
      ownerClient.use { owner ->
        bystanderClient.use { bystander ->
          val ownerJob = launch {
            owner.webSocket(
              method = HttpMethod.Get,
              host = "localhost",
              port = hierarchyServer.getActualPort() ?: error("Server not running"),
              path = "/ws",
            ) {
              incoming.receive() // Connection message
              ownerReady.complete(Unit)
              sendOwnerMessage.await()
              send(Frame.Text("""{"type":"request_hierarchy","requestId":"req-hierarchy"}"""))
              ownerMessages.add((withTimeout(1000) { incoming.receive() } as Frame.Text).readText())
              ownerReceivedUpdate.complete(Unit)
              readLateSequence.await()
              ownerMessages.add((withTimeout(1000) { incoming.receive() } as Frame.Text).readText())
            }
          }

          val bystanderJob = launch {
            bystander.webSocket(
              method = HttpMethod.Get,
              host = "localhost",
              port = hierarchyServer.getActualPort() ?: error("Server not running"),
              path = "/ws",
            ) {
              incoming.receive() // Connection message
              bystanderReady.complete(Unit)
              sendOwnerMessage.await()
              bystanderMessages.add(
                (withTimeout(1000) { incoming.receive() } as Frame.Text).readText()
              )
              bystanderReceivedUpdate.complete(Unit)
              readLateSequence.await()
              bystanderMessages.add(
                (withTimeout(1000) { incoming.receive() } as Frame.Text).readText()
              )
            }
          }

          ownerReady.await()
          bystanderReady.await()
          sendOwnerMessage.complete(Unit)
          ownerReceivedUpdate.await()
          bystanderReceivedUpdate.await()
          hierarchyServer.broadcast(
            ErrorResponse(requestId = "req-hierarchy", error = "late correlated failure")
          )
          hierarchyServer.broadcast("""{"type":"probe"}""")
          readLateSequence.complete(Unit)
          ownerJob.join()
          bystanderJob.join()

          assertEquals(
            "owner should not receive an unowned correlated error",
            listOf("""{"type":"hierarchy_update","hierarchy":{}}""", """{"type":"probe"}"""),
            ownerMessages.toList(),
          )
          assertEquals(
            "an uncorrelated hierarchy response leaves no owner, so a later same-ID frame is dropped",
            listOf("""{"type":"hierarchy_update","hierarchy":{}}""", """{"type":"probe"}"""),
            bystanderMessages.toList(),
          )
        }
      }
    } finally {
      hierarchyServer.stop()
    }
  }
}
