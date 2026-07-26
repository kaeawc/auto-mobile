package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.core.daemon.McpDaemonClient
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
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
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test

/**
 * Coverage for the client-side click-to-tap glue (issue #3347). All tests use fakes or a temporary
 * Unix socket — no real device or daemon connection — so they stay fast and deterministic.
 */
class DeviceControlTapForwarderTest {

  private val forwarder = DeviceControlTapForwarder()

  private fun forward(
    point: DevicePoint,
    client: AutoMobileClient?,
    platform: String = "android",
    deviceId: String? = "emulator-5554",
    onError: (String) -> Unit = { error("unexpected error: $it") },
  ) = forwarder.forward(point, client, platform, deviceId, onError)

  @Test
  fun `in-bounds tap forwards mapped device coordinates to inputTap`() {
    val fake = FakeAutoMobileClient()

    forward(
      DevicePoint(x = 540, y = 1100, inBounds = true),
      client = fake,
      platform = "android",
      deviceId = "emulator-5554",
    )

    // Payload-level assertion on the typed helper: coordinates map verbatim (Int device px ->
    // Double)
    // and the active platform/device id are carried through so a third-party client can match it.
    assertEquals(
      listOf(
        FakeAutoMobileClient.InputTapCall(
          x = 540.0,
          y = 1100.0,
          platform = "android",
          deviceId = "emulator-5554",
          duration = null,
        )
      ),
      fake.inputTapCalls,
    )
  }

  @Test
  fun `out-of-bounds tap is dropped and never reaches the daemon`() {
    val fake = FakeAutoMobileClient()
    var error: String? = null

    forward(
      DevicePoint(x = -3, y = 4000, inBounds = false),
      client = fake,
      onError = { error = it },
    )

    assertTrue(fake.inputTapCalls.isEmpty(), "off-screen tap must not be sent")
    assertTrue("inputTap" !in fake.calls)
    assertNull(error, "dropping an off-screen tap is silent, not an error")
  }

  @Test
  fun `no connected client drops the tap without error`() {
    var error: String? = null

    forward(DevicePoint(x = 10, y = 20, inBounds = true), client = null, onError = { error = it })

    assertNull(error)
  }

  @Test
  fun `daemon failure surfaces the actionable error without crashing`() {
    val fake =
      FakeAutoMobileClient().apply {
        inputTapResult =
          InputActionResult(
            action = "input/tap",
            success = false,
            error = "No active android device to tap",
          )
      }
    var error: String? = null

    forward(DevicePoint(x = 100, y = 200, inBounds = true), client = fake, onError = { error = it })

    // The surfaced message is the daemon's own, not an invented generic string.
    assertEquals("No active android device to tap", error)
  }

  @Test
  fun `thrown client exception surfaces its message instead of propagating`() {
    val throwing =
      object : AutoMobileClient by FakeAutoMobileClient() {
        override fun inputTap(
          x: Double,
          y: Double,
          platform: String,
          deviceId: String?,
          duration: Int?,
        ): InputActionResult = throw IllegalStateException("daemon socket closed")
      }
    var error: String? = null

    forward(DevicePoint(x = 5, y = 6, inBounds = true), client = throwing, onError = { error = it })

    assertEquals("daemon socket closed", error)
  }

  @Test
  fun `failure with no message falls back to the default error`() {
    val fake =
      FakeAutoMobileClient().apply {
        inputTapResult = InputActionResult(action = "input/tap", success = false, error = null)
      }
    var error: String? = null

    forward(DevicePoint(x = 1, y = 2, inBounds = true), client = fake, onError = { error = it })

    assertEquals(DeviceControlTapForwarder.DEFAULT_TAP_ERROR, error)
  }

  @Test
  fun `forwarded tap serializes to the input tap socket request a third-party client can match`() {
    TestDaemonSocket(
        resultJson =
          """{ "action": "input/tap", "platform": "android", "deviceId": "emulator-5554", "success": true }"""
      )
      .use { server ->
        forward(
          DevicePoint(x = 240, y = 640, inBounds = true),
          client = McpDaemonClient(socketPathValue = server.socketPath.toString()),
          platform = "android",
          deviceId = "emulator-5554",
        )

        val request = server.awaitRequest()
        assertEquals("input/tap", request.method)
        assertEquals(
          JsonObject(
            mapOf(
              "platform" to JsonPrimitive("android"),
              "deviceId" to JsonPrimitive("emulator-5554"),
              "x" to JsonPrimitive(240.0),
              "y" to JsonPrimitive(640.0),
            )
          ),
          request.params,
        )
      }
  }

  /** Minimal single-request Unix-socket daemon that captures the request and replies once. */
  private class TestDaemonSocket(private val resultJson: String) : AutoCloseable {
    private val json = Json { ignoreUnknownKeys = true }
    private val tempDir = Files.createTempDirectory(Path.of("/tmp"), "amk-tap-")
    val socketPath: Path = tempDir.resolve("daemon.sock")
    private val serverChannel =
      ServerSocketChannel.open(StandardProtocolFamily.UNIX)
        .bind(UnixDomainSocketAddress.of(socketPath))
    private var captured: CapturedRequest? = null
    private var failure: Throwable? = null
    private val thread = Thread {
      try {
        serverChannel.accept().use { channel ->
          val reader =
            BufferedReader(
              InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8)
            )
          val writer =
            BufferedWriter(
              OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8)
            )
          val request = json.parseToJsonElement(reader.readLine()).jsonObject
          captured =
            CapturedRequest(
              method = request.getValue("method").jsonPrimitive.content,
              params = request.getValue("params").jsonObject,
            )
          val id = request.getValue("id").jsonPrimitive.content
          val compact = resultJson.lineSequence().joinToString("") { it.trim() }
          writer.write(
            """{ "id": "$id", "type": "mcp_response", "success": true, "result": $compact }"""
          )
          writer.newLine()
          writer.flush()
        }
      } catch (throwable: Throwable) {
        failure = throwable
      }
    }
      .also { it.start() }

    fun awaitRequest(): CapturedRequest {
      thread.join(REQUEST_TIMEOUT_MILLIS)
      if (thread.isAlive) throw AssertionError("Forwarder did not send a request before timeout")
      failure?.let { throw AssertionError("Test daemon socket failed", it) }
      return captured ?: throw AssertionError("Forwarder did not send a request")
    }

    override fun close() {
      serverChannel.close()
      Files.deleteIfExists(socketPath)
      Files.deleteIfExists(tempDir)
    }

    private companion object {
      const val REQUEST_TIMEOUT_MILLIS = 5_000L
    }
  }

  private data class CapturedRequest(val method: String, val params: JsonObject)
}
