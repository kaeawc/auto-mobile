package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.StandardProtocolFamily
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.ServerSocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse

class McpDaemonClientInputTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `socket requests declare the desktop client version`() {
    TestDaemonSocket(resultJson = "{}", error = null).use { server ->
      McpDaemonClient(
          socketPathValue = server.socketPath.toString(),
          clientVersion = "0.0.40",
        )
        .ping()

      assertEquals("0.0.40", server.awaitRequest().clientVersion)
    }
  }

  @Test
  fun `capability profile is forwarded across per-request daemon sockets`() {
    TestDaemonSocket(
        responses =
          listOf(
            SocketResponse(
              """{"content":[{"type":"text","text":"{\"sessionUuid\":\"profile-a\"}"}]}""",
              null,
            ),
            SocketResponse("""{"tools":[]}""", null),
            SocketResponse("""{"content":[]}""", null),
          )
      )
      .use { server ->
        val client = McpDaemonClient(socketPathValue = server.socketPath.toString())

        client.enableToolCapability("screen-artifacts")
        client.listTools()
        client.callTool("videoRecording", JsonObject(emptyMap()))

        val requests = server.awaitRequests()
        assertEquals("setToolCapability", requests[0].params["name"]?.jsonPrimitive?.content)
        assertEquals("tools/list", requests[1].method)
        assertEquals(
          "profile-a",
          requests[1].params["__autoMobileCapabilityProfileUuid"]?.jsonPrimitive?.content,
        )
        assertEquals("videoRecording", requests[2].params["name"]?.jsonPrimitive?.content)
        val arguments = requests[2].params["arguments"]?.jsonObject
        assertEquals(
          "profile-a",
          arguments?.get("__autoMobileCapabilityProfileUuid")?.jsonPrimitive?.content,
        )
      }
  }

  @Test
  fun `desktop session uuid is injected into tool calls without overriding explicit routing`() {
    TestDaemonSocket(
        responses =
          listOf(
            SocketResponse(resultJson = "{}"),
            SocketResponse(resultJson = "{}"),
            SocketResponse(resultJson = "{}"),
          )
      )
      .use { server ->
        val client =
          McpDaemonClient(
            socketPathValue = server.socketPath.toString(),
            sessionUuid = "desktop-session",
          )

        client.callTool("observe", JsonObject(emptyMap()))
        client.callTool(
          "observe",
          JsonObject(mapOf("sessionUuid" to JsonPrimitive("explicit-session"))),
        )
        client.callTool("setToolCapability", JsonObject(emptyMap()))

        val requests = server.awaitRequests()
        assertEquals(
          "desktop-session",
          requests[0].params["arguments"]?.jsonObject?.get("sessionUuid")?.jsonPrimitive?.content,
        )
        assertEquals(
          "explicit-session",
          requests[1].params["arguments"]?.jsonObject?.get("sessionUuid")?.jsonPrimitive?.content,
        )
        assertFalse(
          "sessionUuid" in (requests[2].params["arguments"]?.jsonObject ?: JsonObject(emptyMap()))
        )
      }
  }

  @Test
  fun `desktop daemon session exposes one identity and releases it only once`() {
    TestDaemonSocket(
        responses =
          listOf(
            SocketResponse(resultJson = "{\"heartbeat\":true}"),
            SocketResponse(resultJson = "{\"released\":true}"),
          )
      )
      .use { server ->
        val session =
          DesktopDaemonSession(
            McpDaemonClient(
              socketPathValue = server.socketPath.toString(),
              sessionUuid = "desktop-session",
            )
          )

        assertEquals("desktop-session", session.sessionUuid)
        assertEquals("desktop-session", session.sessionUuidProvider())
        session.heartbeat()
        session.release()
        assertNull(session.sessionUuidProvider())
        session.release()

        val requests = server.awaitRequests()
        assertEquals(
          listOf("daemon/heartbeat", "daemon/releaseSession"),
          requests.map { it.method },
        )
        assertEquals(
          "desktop-session",
          requests[1].params["sessionId"]?.jsonPrimitive?.content,
        )
      }
  }

  @Test
  fun `capability enable tolerates an older daemon without the control tool`() {
    TestDaemonSocket(
        responses =
          listOf(
            SocketResponse(error = "Unknown tool: setToolCapability"),
            SocketResponse("""{"content":[]}""", null),
          )
      )
      .use { server ->
        val client = McpDaemonClient(socketPathValue = server.socketPath.toString())

        client.enableToolCapability("screen-artifacts")
        client.callTool("videoRecording", JsonObject(emptyMap()))

        assertEquals(
          listOf("setToolCapability", "videoRecording"),
          server.awaitRequests().map { it.params["name"]?.jsonPrimitive?.content },
        )
      }
  }

  @Test
  fun `socket requests surface lifecycle failures before opening the socket`() {
    val lifecycle =
      object : DaemonLifecycleEnsurer {
        override fun ensureVersionMatchedDaemon(): DaemonLifecycleResult =
          DaemonLifecycleResult.Failure("daemon version mismatch")
      }

    val error =
      assertFailsWith<DaemonUnavailableException> {
        McpDaemonClient(
            socketPathValue = "/tmp/not-a-daemon.sock",
            daemonLifecycle = lifecycle,
          )
          .ping()
      }

    assertEquals("daemon version mismatch", error.message)
  }

  @Test
  fun `inputTap serializes to input tap socket request`() {
    val responseResult =
      """
      {
        "action": "input/tap",
        "platform": "android",
        "deviceId": "emulator-5554",
        "success": true,
        "coordinates": { "x": 240.5, "y": 640.25 }
      }
      """
        .trimIndent()

    val result =
      captureInputRequest(responseResult) { client ->
        client.inputTap(
          x = 240.5,
          y = 640.25,
          platform = "android",
          deviceId = "emulator-5554",
          duration = 50,
          frameContext = "android:41",
        )
      }

    assertEquals("input/tap", result.request.method)
    assertEquals(
      mapOf(
        "platform" to JsonPrimitive("android"),
        "deviceId" to JsonPrimitive("emulator-5554"),
        "x" to JsonPrimitive(240.5),
        "y" to JsonPrimitive(640.25),
        "duration" to JsonPrimitive(50),
        "frameContext" to JsonPrimitive("android:41"),
      ),
      result.request.params,
    )
    assertEquals(true, result.response.success)
    assertEquals(InputCoordinates(x = 240.5, y = 640.25), result.response.coordinates)
  }

  @Test
  fun `an input without a frame context omits the param for legacy daemons`() {
    val result =
      captureInputRequest("""{ "action": "input/tap", "success": true }""") { client ->
        client.inputTap(x = 1.0, y = 2.0)
      }

    assertFalse("frameContext" in result.request.params)
  }

  @Test
  fun `inputSwipe serializes documented coordinate and duration params`() {
    val responseResult =
      """
      {
        "action": "input/swipe",
        "platform": "android",
        "deviceId": "emulator-5554",
        "success": true,
        "start": { "x": 520.75, "y": 1700.5 },
        "end": { "x": 520.25, "y": 500.5 },
        "durationMs": 350
      }
      """
        .trimIndent()

    val result =
      captureInputRequest(responseResult) { client ->
        client.inputSwipe(
          startX = 520.75,
          startY = 1700.5,
          endX = 520.25,
          endY = 500.5,
          platform = "android",
          deviceId = "emulator-5554",
          durationMs = 350,
          frameContext = "android:42",
        )
      }

    assertEquals("input/swipe", result.request.method)
    assertEquals(
      mapOf(
        "platform" to JsonPrimitive("android"),
        "deviceId" to JsonPrimitive("emulator-5554"),
        "startX" to JsonPrimitive(520.75),
        "startY" to JsonPrimitive(1700.5),
        "endX" to JsonPrimitive(520.25),
        "endY" to JsonPrimitive(500.5),
        "durationMs" to JsonPrimitive(350),
        "frameContext" to JsonPrimitive("android:42"),
      ),
      result.request.params,
    )
    assertEquals(true, result.response.success)
    assertEquals(InputCoordinates(x = 520.75, y = 1700.5), result.response.start)
    assertEquals(InputCoordinates(x = 520.25, y = 500.5), result.response.end)
    assertEquals(350, result.response.durationMs)
  }

  @Test
  fun `button text and key helpers serialize to their input socket methods`() {
    val pressButton =
      captureInputRequest(
        """{ "action": "input/pressButton", "success": true, "button": "back" }"""
      ) { client ->
        client.inputPressButton(
          button = "back",
          platform = "android",
          deviceId = "device-1",
          frameContext = "android:43",
        )
      }
    val typeText =
      captureInputRequest(
        """{ "action": "input/typeText", "success": true, "textLength": 5, "submitted": true }"""
      ) { client ->
        client.inputTypeText(
          text = "hello",
          platform = "ios",
          deviceId = "device-2",
          submit = true,
          frameContext = "ios:43",
        )
      }
    val key =
      captureInputRequest("""{ "action": "input/key", "success": true, "key": "enter" }""") { client
        ->
        client.inputKey(
          key = "enter",
          platform = "android",
          deviceId = "device-3",
          frameContext = "android:44",
        )
      }

    assertEquals("input/pressButton", pressButton.request.method)
    assertEquals(
      mapOf(
        "platform" to JsonPrimitive("android"),
        "deviceId" to JsonPrimitive("device-1"),
        "button" to JsonPrimitive("back"),
        "frameContext" to JsonPrimitive("android:43"),
      ),
      pressButton.request.params,
    )
    assertEquals("back", pressButton.response.button)

    assertEquals("input/typeText", typeText.request.method)
    assertEquals(
      mapOf(
        "platform" to JsonPrimitive("ios"),
        "deviceId" to JsonPrimitive("device-2"),
        "text" to JsonPrimitive("hello"),
        "submit" to JsonPrimitive(true),
        "frameContext" to JsonPrimitive("ios:43"),
      ),
      typeText.request.params,
    )
    assertEquals(5, typeText.response.textLength)
    assertEquals(true, typeText.response.submitted)

    assertEquals("input/key", key.request.method)
    assertEquals(
      mapOf(
        "platform" to JsonPrimitive("android"),
        "deviceId" to JsonPrimitive("device-3"),
        "key" to JsonPrimitive("enter"),
        "frameContext" to JsonPrimitive("android:44"),
      ),
      key.request.params,
    )
    assertEquals("enter", key.response.key)
  }

  @Test
  fun `input helpers decode failure envelopes into result errors`() {
    val result =
      captureInputRequest(error = "input/key is unsupported on ios") { client ->
        client.inputKey(key = "enter", platform = "ios", deviceId = "simulator-1")
      }

    assertEquals("input/key", result.request.method)
    assertEquals(false, result.response.success)
    assertEquals("input/key is unsupported on ios", result.response.error)
  }

  @Test
  fun `append mode shares a capability query across per-action socket clients`() {
    TestDaemonSocket(
        responses =
          listOf(
            SocketResponse(resultJson = """{ "capabilities": ["input/typeText.mode:append"] }"""),
            SocketResponse(resultJson = """{ "action": "input/typeText", "success": true }"""),
            SocketResponse(resultJson = """{ "action": "input/typeText", "success": true }"""),
          )
      )
      .use { server ->
        McpDaemonClient(socketPathValue = server.socketPath.toString())
          .inputTypeText(
            text = "a",
            append = true,
          )
        McpDaemonClient(socketPathValue = server.socketPath.toString())
          .inputTypeText(
            text = "b",
            append = true,
          )

        assertEquals(
          listOf("daemon/capabilities", "input/typeText", "input/typeText"),
          server.awaitRequests().map { it.method },
        )
        assertEquals(JsonPrimitive("append"), server.awaitRequests()[1].params["mode"])
      }
  }

  @Test
  fun `append mode falls back to the append request when an older daemon has no capabilities endpoint`() {
    TestDaemonSocket(
        responses =
          listOf(
            SocketResponse(error = "Unsupported daemon method: daemon/capabilities"),
            SocketResponse(resultJson = """{ "action": "input/typeText", "success": true }"""),
          )
      )
      .use { server ->
        val result =
          McpDaemonClient(socketPathValue = server.socketPath.toString())
            .inputTypeText(
              text = "a",
              append = true,
            )

        assertEquals("daemon/capabilities", server.awaitRequest().method)
        assertEquals(
          listOf("daemon/capabilities", "input/typeText"),
          server.awaitRequests().map { it.method },
        )
        assertEquals(JsonPrimitive("append"), server.awaitRequests()[1].params["mode"])
        assertEquals(true, result.success)
      }
  }

  @Test
  fun `append mode reports an unsupported parameter after a legacy capability probe`() {
    TestDaemonSocket(
        responses =
          listOf(
            SocketResponse(error = "Unsupported daemon method: daemon/capabilities"),
            SocketResponse(error = "input/typeText unsupported params: mode"),
          )
      )
      .use { server ->
        val result =
          McpDaemonClient(socketPathValue = server.socketPath.toString())
            .inputTypeText(
              text = "a",
              append = true,
            )

        assertEquals(
          listOf("daemon/capabilities", "input/typeText"),
          server.awaitRequests().map { it.method },
        )
        assertEquals(false, result.success)
        assertEquals(
          "The connected daemon does not support input/typeText mode:append. Restart or update the daemon before typing into the device.",
          result.error,
        )
      }
  }

  @Test
  fun `append mode preserves a capability probe handshake error`() {
    TestDaemonSocket(error = "AutoMobile daemon version mismatch: desktop requires 1.2.0").use {
      server ->
      val result =
        McpDaemonClient(
            socketPathValue = server.socketPath.toString(),
            clientVersion = "1.2.0",
          )
          .inputTypeText(
            text = "a",
            append = true,
          )

      assertEquals("daemon/capabilities", server.awaitRequest().method)
      assertEquals("1.2.0", server.awaitRequest().clientVersion)
      assertEquals(false, result.success)
      assertEquals(
        "AutoMobile daemon version mismatch: desktop requires 1.2.0",
        result.error,
      )
    }
  }

  @Test
  fun `append mode rejects a successful capability probe without capabilities`() {
    TestDaemonSocket(resultJson = "{}").use { server ->
      val result =
        McpDaemonClient(socketPathValue = server.socketPath.toString())
          .inputTypeText(
            text = "a",
            append = true,
          )

      assertEquals(listOf("daemon/capabilities"), server.awaitRequests().map { it.method })
      assertEquals(false, result.success)
      assertEquals("Daemon capability probe returned an invalid result.", result.error)
    }
  }

  @Test
  fun `input helpers reject malformed success payloads`() {
    TestDaemonSocket(resultJson = "{}", error = null).use { server ->
      assertFailsWith<SerializationException> {
        McpDaemonClient(socketPathValue = server.socketPath.toString()).inputTap(x = 10.0, y = 20.0)
      }
      assertEquals("input/tap", server.awaitRequest().method)
    }
  }

  @Test
  fun `input helpers reject success payloads for a different action`() {
    val result =
      captureInputRequest("""{ "action": "input/swipe", "success": true }""") { client ->
        client.inputTap(x = 10.0, y = 20.0)
      }

    assertEquals(false, result.response.success)
    assertEquals(
      "Daemon response action input/swipe did not match input/tap",
      result.response.error,
    )
  }

  @Test
  fun `non socket clients explicitly report unsupported typed input`() {
    val httpResult = McpHttpClient("http://localhost:1/auto-mobile/streamable").inputTap(1.0, 2.0)
    val stdioResult = McpStdioClient("unused").inputTap(1.0, 2.0)

    assertEquals(false, httpResult.success)
    assertEquals("input/tap", httpResult.action)
    assertEquals("MCP HTTP does not support direct daemon input helpers", httpResult.error)
    assertEquals(false, stdioResult.success)
    assertEquals("input/tap", stdioResult.action)
    assertEquals("MCP STDIO does not support direct daemon input helpers", stdioResult.error)
  }

  private fun captureInputRequest(
    resultJson: String? = null,
    error: String? = null,
    call: (McpDaemonClient) -> InputActionResult,
  ): CapturedInputCall {
    TestDaemonSocket(resultJson = resultJson, error = error).use { server ->
      val response = call(McpDaemonClient(socketPathValue = server.socketPath.toString()))
      return CapturedInputCall(server.awaitRequest(), response)
    }
  }

  private inner class TestDaemonSocket(
    resultJson: String? = null,
    error: String? = null,
    private val responses: List<SocketResponse> = listOf(SocketResponse(resultJson, error)),
  ) : AutoCloseable {
    private val tempDir = Files.createTempDirectory(Path.of("/tmp"), "amk-")
    val socketPath = tempDir.resolve("daemon.sock")
    private val serverChannel =
      ServerSocketChannel.open(StandardProtocolFamily.UNIX)
        .bind(UnixDomainSocketAddress.of(socketPath))
    private val capturedRequests = mutableListOf<CapturedDaemonRequest>()
    private var failure: Throwable? = null
    private val thread = Thread {
      try {
        responses.forEach { response ->
          serverChannel.accept().use { channel ->
            val reader =
              BufferedReader(
                InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8)
              )
            val writer =
              BufferedWriter(
                OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8)
              )
            val requestLine = reader.readLine()
            val request = json.parseToJsonElement(requestLine).jsonObject
            capturedRequests.add(
              CapturedDaemonRequest(
                method = request.getValue("method").jsonPrimitive.content,
                params = request.getValue("params").jsonObject,
                clientVersion = request["clientVersion"]?.jsonPrimitive?.content,
              )
            )
            writer.write(responseLine(request.getValue("id").jsonPrimitive.content, response))
            writer.newLine()
            writer.flush()
          }
        }
      } catch (throwable: Throwable) {
        failure = throwable
      }
    }
      .also { it.start() }

    fun awaitRequest(): CapturedDaemonRequest {
      thread.join(REQUEST_TIMEOUT_MILLIS)
      if (thread.isAlive) {
        throw AssertionError("Daemon client did not send a request before timeout")
      }
      failure?.let { throw AssertionError("Test daemon socket failed", it) }
      return capturedRequests.firstOrNull()
        ?: throw AssertionError("Daemon client did not send a request")
    }

    fun awaitRequests(): List<CapturedDaemonRequest> {
      thread.join(REQUEST_TIMEOUT_MILLIS)
      if (thread.isAlive) {
        throw AssertionError("Daemon client did not send every request before timeout")
      }
      failure?.let { throw AssertionError("Test daemon socket failed", it) }
      return capturedRequests.toList()
    }

    private fun responseLine(requestId: String, response: SocketResponse): String {
      val body =
        if (response.error == null) {
          """"result": ${compactJson(response.resultJson ?: "{}")}"""
        } else {
          """"error": ${JsonPrimitive(response.error)}"""
        }
      val success = response.error == null
      return """{ "id": "$requestId", "type": "mcp_response", "success": $success, $body }"""
    }

    private fun compactJson(value: String): String =
      value.lineSequence().joinToString(separator = "") { it.trim() }

    override fun close() {
      serverChannel.close()
      Files.deleteIfExists(socketPath)
      Files.deleteIfExists(tempDir)
    }
  }

  private companion object {
    const val REQUEST_TIMEOUT_MILLIS = 5_000L
  }
}

private data class CapturedInputCall(
  val request: CapturedDaemonRequest,
  val response: InputActionResult,
)

private data class SocketResponse(
  val resultJson: String? = null,
  val error: String? = null,
)

private data class CapturedDaemonRequest(
  val method: String,
  val params: JsonObject,
  val clientVersion: String?,
)
