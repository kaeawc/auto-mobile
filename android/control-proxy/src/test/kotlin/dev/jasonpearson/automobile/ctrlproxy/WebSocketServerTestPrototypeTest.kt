package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeEventKind
import dev.jasonpearson.automobile.protocol.PrototypeResult
import dev.jasonpearson.automobile.protocol.RequestHierarchy
import dev.jasonpearson.automobile.protocol.WebSocketMessageHandler
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import io.ktor.websocket.Frame
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Prototype host routing, malformed assets, payload caps, and safe decode errors. */
@RunWith(RobolectricTestRunner::class)
internal class WebSocketServerTestPrototypeTest : WebSocketServerTestFixtures() {

  @Test
  fun `a prototype request goes to the latest connected host and to no one else`() =
    runTest(testScope.testScheduler) {
      val older = RecordingTransport()
      val latest = RecordingTransport()
      server.registerClient(1, older)
      server.registerClient(2, latest)
      val frame = """{"type":"prototype_request","requestId":"r-1"}"""

      assertNotNull(server.sendToHost(frame))
      runCurrent()

      assertEquals(listOf(frame), latest.messages)
      assertTrue(older.messages.isEmpty())
    }

  @Test
  fun `a host whose queue is full is disconnected and not reported as the request's owner`() =
    runTest(testScope.testScheduler) {
      val stalled = StalledTransport()
      server.registerClient(1, stalled)
      server.broadcast("""{"type":"must_deliver","index":-1}""")
      runCurrent() // The stalled sender is blocked on its first frame.
      repeat(WebSocketServer.OUTGOING_HARD_CEILING) {
        server.broadcast("""{"type":"must_deliver","index":$it}""")
      }

      assertNull(server.sendToHost("""{"type":"prototype_request","requestId":"r-1"}"""))
      runCurrent()

      assertEquals(0, server.getConnectionCount())
    }

  @Test
  fun `with no connected host a prototype request is not sent`() {
    assertNull(server.sendToHost("""{"type":"prototype_request","requestId":"r-1"}"""))
  }

  @Test
  fun `a host prototype response is routed to its handler and never decoded as a request`() =
    runTest(testScope.testScheduler) {
      val responses = mutableListOf<String>()
      val handled = mutableListOf<WebSocketRequest>()
      val routed =
        WebSocketServer(
          port = 0,
          scope = testScope,
          options =
            WebSocketServerOptions(
              messageHandler =
                object : WebSocketMessageHandler {
                  override suspend fun handleMessage(
                    request: WebSocketRequest,
                  ): WebSocketResponse? {
                    handled += request
                    return null
                  }
                },
              onPrototypeResponse = { responses += it },
            ),
        )
      val transport = RecordingTransport()
      val client = routed.registerClient(1, transport)
      val frame =
        """{"type":"prototype_response","requestId":"r-1","ok":true,"status":200,"headers":{},"body":null,"durationMs":3}"""

      routed.handleClientMessage(frame, client)
      runCurrent()

      assertEquals(listOf(frame), responses)
      assertTrue(handled.isEmpty())
      // No error frame came back for an unknown request type.
      assertTrue(transport.messages.isEmpty())
    }

  @Test
  fun `known prototype nested decode failures return correlated prototype results`() =
    runTest(testScope.testScheduler) {
      server = serverWithHandler { error("Malformed payload must never dispatch") }
      val transport = RecordingTransport()
      val owner = server.registerClient(1, transport)
      val cases =
        listOf(
          "root" to
            """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"unknown_node"}}""",
          "onTap" to
            """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hi","onTap":[{"type":"unknown_action"}]}}""",
          "placement" to
            """{"id":"panel","window":{"placement":{"type":"unknown_placement"}},"root":{"type":"text","text":"Hi"}}""",
          "root" to
            """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"text":"Missing type"}}""",
        )
      for (command in listOf("show_prototype")) {
        for ((index, case) in cases.withIndex()) {
          val (field, spec) = case
          val requestId = "$command-$index"
          val raw = """{"type":"$command","requestId":"$requestId","id":"panel","spec":$spec}"""
          server.handleClientMessage(raw, owner)
          runCurrent()
          val response = Json.decodeFromString<WebSocketResponse>(transport.messages.last())
          assertTrue("Expected prototype_result: $response", response is PrototypeResult)
          val result = response as PrototypeResult
          assertEquals(requestId, result.requestId)
          assertFalse(result.success)
          assertTrue(
            "Expected field $field: ${result.error}",
            result.error?.contains(field) == true,
          )
          assertTrue(result.error?.startsWith("Malformed request:") == true)
        }
      }
    }

  @Test
  fun `malformed prototype asset requests get one correlated prototype result and no echoed bytes`() =
    runTest(testScope.testScheduler) {
      server = serverWithHandler { error("Malformed payload must never dispatch") }
      val transport = RecordingTransport()
      val owner = server.registerClient(1, transport)
      val bytes = "SECRETBYTES".repeat(8)
      val cases =
        listOf(
          """{"type":"put_prototype_asset","requestId":"put-bad","id":"hero","mimeType":"image/png","dataBase64":{}}""",
          """{"type":"put_prototype_asset","requestId":"put-missing","mimeType":"image/png","dataBase64":"$bytes"}""",
          """{"type":"remove_prototype_asset","requestId":"remove-bad","id":7}""",
        )
      for (raw in cases) {
        val before = transport.messages.size
        server.handleClientMessage(raw, owner)
        runCurrent()
        assertEquals(before + 1, transport.messages.size)
        val result =
          Json.decodeFromString<WebSocketResponse>(transport.messages.last()) as PrototypeResult
        assertEquals(
          Regex("\"requestId\":\"([^\"]+)\"").find(raw)!!.groupValues[1],
          result.requestId,
        )
        assertFalse(result.success)
        assertTrue(result.error.orEmpty().startsWith("Malformed request:"))
        assertFalse(result.error.orEmpty().contains("SECRETBYTES"))
      }
    }

  @Test
  fun `an asset frame above its type's cap is answered without being deserialized`() =
    runTest(testScope.testScheduler) {
      server =
        WebSocketServer(
          port = 0,
          scope = testScope,
          options =
            WebSocketServerOptions(
              messageHandler =
                object : WebSocketMessageHandler {
                  override suspend fun handleMessage(
                    request: WebSocketRequest,
                  ): WebSocketResponse? = error("An oversized frame must never dispatch")
                },
              inboundFrameLimits = InboundFrameLimits(mapOf("put_prototype_asset" to 128L)),
            ),
        )
      val transport = RecordingTransport()
      val owner = server.registerClient(1, transport)
      // `dataBase64` is not a string, so a full decode would fail with "Malformed request:"; the
      // cap reply proves the frame was never deserialized.
      val raw =
        """{"requestId":"put-big","id":"hero","mimeType":"image/png","dataBase64":["${"SECRETBYTES".repeat(16)}"],"type":"put_prototype_asset"}"""
      server.handleInboundTextFrame(1, Frame.Text(raw), owner)
      runCurrent()
      val reply = transport.messages.single()
      assertFalse(reply, reply.contains("SECRETBYTES"))
      val result = Json.decodeFromString<WebSocketResponse>(reply) as PrototypeResult
      assertEquals("put-big", result.requestId)
      assertFalse(result.success)
      assertEquals(
        "Request frame for put_prototype_asset is ${raw.encodeToByteArray().size} bytes; " +
          "the limit is 128 bytes.",
        result.error,
      )
    }

  @Test
  fun `a frame within its type's cap is decoded and dispatched`() =
    runTest(testScope.testScheduler) {
      val received = mutableListOf<WebSocketRequest>()
      server =
        WebSocketServer(
          port = 0,
          scope = testScope,
          options =
            WebSocketServerOptions(
              messageHandler =
                object : WebSocketMessageHandler {
                  override suspend fun handleMessage(
                    request: WebSocketRequest,
                  ): WebSocketResponse? {
                    received += request
                    return null
                  }
                },
              inboundFrameLimits = InboundFrameLimits(mapOf("put_prototype_asset" to 16L)),
            ),
        )
      val owner = server.registerClient(1, RecordingTransport())
      // Above the smallest cap but of an uncapped type, so it decodes as before.
      server.handleInboundTextFrame(
        1,
        Frame.Text("""{"type":"request_hierarchy","requestId":"h1"}"""),
        owner,
      )
      advanceUntilIdle()
      assertEquals(listOf<WebSocketRequest>(RequestHierarchy(requestId = "h1")), received)
    }

  @Test
  fun `a syntax error next to asset bytes does not echo them in the error reply`() =
    runTest(testScope.testScheduler) {
      server = serverWithHandler { error("Malformed payload must never dispatch") }
      val transport = RecordingTransport()
      val owner = server.registerClient(1, transport)
      val bytes = "SECRETBYTES".repeat(8)
      // The parser fails right after the data, so its input snippet is made of the data. The
      // frame is not valid JSON, so its type is unreadable and the reply is a generic error.
      val raw =
        """{"type":"put_prototype_asset","requestId":"put-adjacent","id":"hero","mimeType":"image/png","dataBase64":"$bytes" "x"}"""
      server.handleClientMessage(raw, owner)
      runCurrent()
      assertEquals(1, transport.messages.size)
      val reply = transport.messages.single()
      assertFalse(reply, reply.contains("SECRETBYTES"))
      assertTrue(reply, reply.contains("Malformed request:"))
      assertTrue("diagnosis is kept: $reply", reply.contains("offset"))
    }

  @Test
  fun `a well formed asset frame that fails decoding next to the data echoes no bytes`() =
    runTest(testScope.testScheduler) {
      server = serverWithHandler { error("Malformed payload must never dispatch") }
      val transport = RecordingTransport()
      val owner = server.registerClient(1, transport)
      val bytes = "SECRETBYTES".repeat(8)
      server.handleClientMessage(
        """{"type":"put_prototype_asset","requestId":"adj","dataBase64":"$bytes","mimeType":["image/png"],"id":"hero"}""",
        owner,
      )
      runCurrent()
      assertEquals(1, transport.messages.size)
      val reply = transport.messages.single()
      assertFalse(reply, reply.contains("SECRETBYTES"))
      assertTrue(Json.decodeFromString<WebSocketResponse>(reply) is PrototypeResult)
    }

  @Test
  fun `a truncated asset frame whose type cannot be parsed still echoes no bytes`() =
    runTest(testScope.testScheduler) {
      server = serverWithHandler { error("Malformed payload must never dispatch") }
      val transport = RecordingTransport()
      val owner = server.registerClient(1, transport)
      val bytes = "SECRETBYTES".repeat(8)
      server.handleClientMessage(
        """{"type":"put_prototype_asset","requestId":"cut","id":"hero","dataBase64":"$bytes""",
        owner,
      )
      runCurrent()
      assertEquals(1, transport.messages.size)
      assertFalse(transport.messages.single().contains("SECRETBYTES"))
    }

  @Test
  fun `describeDecodeFailure drops the parser input snippet for asset frames only`() {
    val snippet = "JSON input: ...SECRETBYTES..."
    val failure = IllegalArgumentException("Unexpected JSON token at offset 40: bad\n$snippet")
    val asset = """{"type":"put_prototype_asset","dataBase64":"SECRETBYTES"}"""
    assertEquals(
      "Malformed request: Unexpected JSON token at offset 40: bad",
      WebSocketServer.describeDecodeFailure(asset, failure),
    )
    val other = """{"type":"show_prototype","x":"oops"}"""
    assertTrue(WebSocketServer.describeDecodeFailure(other, failure).contains("SECRETBYTES"))
  }

  @Test
  fun `asset requests are advertised so older devices can be detected by absence`() {
    val commands = WebSocketServer(port = 0, scope = testScope).supportedCommands()
    assertTrue(commands.contains("put_prototype_asset"))
    assertTrue(commands.contains("remove_prototype_asset"))
    assertTrue(commands.contains("full_command_set_v1"))
  }

  @Test
  fun `dismiss payload failure is a prototype result while other known commands keep error frames`() =
    runTest(testScope.testScheduler) {
      server = serverWithHandler { error("Malformed payload must never dispatch") }
      val transport = RecordingTransport()
      val owner = server.registerClient(1, transport)
      server.handleClientMessage(
        """{"type":"dismiss_prototype","requestId":"dismiss-bad","all":{}}""",
        owner,
      )
      runCurrent()
      val prototype =
        Json.decodeFromString<WebSocketResponse>(transport.messages.last()) as PrototypeResult
      assertEquals("dismiss-bad", prototype.requestId)
      assertFalse(prototype.success)
      assertTrue(prototype.error?.contains("all") == true)
      server.handleClientMessage(
        """{"type":"request_screenshot","requestId":"known-bad","displayId":{}}""",
        owner,
      )
      runCurrent()
      val known =
        Json.decodeFromString<WebSocketResponse>(transport.messages.last()) as ErrorResponse
      assertEquals("known-bad", known.requestId)
      assertTrue(known.error.startsWith("Malformed request:"))
      server.handleClientMessage("""{"type":"truly_unknown","requestId":"unknown"}""", owner)
      runCurrent()
      val unknown =
        Json.decodeFromString<WebSocketResponse>(transport.messages.last()) as ErrorResponse
      assertEquals("unknown", unknown.requestId)
      assertEquals("Unknown command type: truly_unknown", unknown.error)
    }

  @Test
  fun `prototype results correlate while prototype events do not`() {
    assertEquals(
      "prototype-r",
      WebSocketServer.correlationRequestId(
        PrototypeResult(timestamp = 0L, requestId = "prototype-r", success = false),
      ),
    )
    assertNull(
      WebSocketServer.correlationRequestId(
        PrototypeEvent(
          timestamp = 0L,
          id = "panel",
          sequence = 1L,
          kind = PrototypeEventKind.DISMISSED,
          name = null,
          payload = null,
          state = emptyMap(),
        ),
      ),
    )
  }
}
