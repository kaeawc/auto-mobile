package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.RequestScreenshot
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.get
import io.ktor.http.HttpMethod
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Real socket highlight commands, decode failures, handler failures, and wire ordering. */
@RunWith(RobolectricTestRunner::class)
internal class WebSocketServerIntegrationTestCommandTest :
  WebSocketServerIntegrationTestFixtures() {

  @Test
  fun `add_highlight returns highlight response`() = runBlocking {
    startAndWait(server)

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
          """{"type":"add_highlight","requestId":"$requestId","id":"highlight-1","shape":{"type":"circle","bounds":{"x":10,"y":20,"width":100,"height":80}}}"""
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
  fun `unsupported highlights return error responses`() = runBlocking {
    startAndWait(server)

    val client = HttpClient(CIO) { install(WebSockets) }
    client.use { client ->
      client.webSocket(
        method = HttpMethod.Get,
        host = "localhost",
        port = getServerPort(),
        path = "/ws",
      ) {
        incoming.receive() // Connection message

        for (shapeType in listOf("box", "path")) {
          val requestId = "req-add-$shapeType"
          val message =
            """{"type":"add_highlight","requestId":"$requestId","id":"unsupported-1","shape":{"type":"$shapeType","bounds":{"x":10,"y":20,"width":100,"height":80}}}"""
          send(Frame.Text(message))

          val responseFrame = withTimeout(1000) { incoming.receive() } as Frame.Text
          val responseJson = json.parseToJsonElement(responseFrame.readText()).jsonObject

          assertEquals("highlight_response", responseJson["type"]?.jsonPrimitive?.content)
          assertEquals(requestId, responseJson["requestId"]?.jsonPrimitive?.content)
          assertEquals("false", responseJson["success"]?.jsonPrimitive?.content)
          assertEquals(
            "Only hand-drawn circle highlights are supported",
            responseJson["error"]?.jsonPrimitive?.content,
          )
        }
      }
    }
  }

  @Test
  fun `invalid add_highlight returns error response`() = runBlocking {
    startAndWait(server)

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
          """{"type":"add_highlight","requestId":"$requestId","shape":{"type":"circle","bounds":{"x":10,"y":20,"width":100,"height":80}}}"""
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
    startAndWait(server)

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
    startAndWait(server)

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
            """{"type":"request_tap_coordinates","requestId":"req-out-of-range","x":1e309,"y":10}""",
          ),
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
    startAndWait(server)

    assertErrorTargetsOrigin(
      server,
      """{"type":"totally_unknown_command","requestId":"req-owner"}""",
      "req-owner",
    )
  }

  @Test
  fun `unparseable payload returns error response with null requestId`() = runBlocking {
    // Best-effort requestId extraction (#2985): when the payload can't be parsed at all, the error
    // frame is still emitted with a null requestId rather than swallowed.
    startAndWait(server)

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
        options =
          WebSocketServerOptions(
            messageHandler =
              CtrlProxyMessageHandler(
                object : NoOpCtrlProxyActions() {
                  override suspend fun requestScreenshot(request: RequestScreenshot) {
                    throw IllegalStateException("kaboom")
                  }
                },
              ),
          ),
      )
    startAndWait(throwingServer)
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
        options =
          WebSocketServerOptions(
            messageHandler =
              CtrlProxyMessageHandler(
                object : NoOpCtrlProxyActions() {
                  override suspend fun requestScreenshot(request: RequestScreenshot) {
                    throw IllegalStateException("kaboom")
                  }
                },
              ),
          ),
      )
    startAndWait(throwingServer)
    try {
      assertErrorTargetsOrigin(
        throwingServer,
        """{"type":"request_screenshot","requestId":"req-throw-owner"}""",
        "req-throw-owner",
      )
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
        options =
          WebSocketServerOptions(
            messageHandler =
              CtrlProxyMessageHandler(
                object : NoOpCtrlProxyActions() {
                  override suspend fun setRecompositionTracking(enabled: Boolean) {
                    order.add("flags")
                  }

                  override suspend fun requestScreenshot(request: RequestScreenshot) {
                    order.add("screenshot")
                  }
                },
              ),
          ),
      )
    startAndWait(orderedServer)
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
}
