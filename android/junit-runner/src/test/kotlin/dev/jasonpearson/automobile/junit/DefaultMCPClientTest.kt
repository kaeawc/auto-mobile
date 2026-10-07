package dev.jasonpearson.automobile.junit

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/**
 * The recovery client talks to the daemon over its socket, not a made-up HTTP endpoint (#10089).
 */
class DefaultMCPClientTest {

  private class FakeConnectivity(var alive: Boolean = true) : DaemonConnectivityChecker {
    override fun isDaemonAlive() = alive

    override fun waitForDaemon(timeoutMs: Long) = alive
  }

  private class FakeDaemon(var response: DaemonResponse) : AutoMobileAgent.DaemonToolCaller {
    val calls = mutableListOf<Pair<String, JsonObject>>()

    override fun call(toolName: String, arguments: JsonObject, timeoutMs: Long): DaemonResponse {
      calls += toolName to arguments
      return response
    }
  }

  private fun ok(result: String) =
    DaemonResponse("1", "mcp_response", true, Json.parseToJsonElement(result))

  private fun client(daemon: FakeDaemon, connectivity: FakeConnectivity = FakeConnectivity()) =
    AutoMobileAgent.DefaultMCPClient(daemon, connectivity).also { it.connect("http://unused") }

  @Test
  fun `connect fails with an actionable message when the daemon is not reachable`() {
    val unreachable =
      AutoMobileAgent.DefaultMCPClient(FakeDaemon(ok("{}")), FakeConnectivity(false))

    val error = assertThrows<RuntimeException> { unreachable.connect("http://localhost:3000") }

    assertTrue(error.message!!.contains("daemon is not reachable"), error.message)
    assertFalse(unreachable.isConnected())
  }

  @Test
  fun `callTool before connect is rejected`() {
    val client = AutoMobileAgent.DefaultMCPClient(FakeDaemon(ok("{}")), FakeConnectivity())

    assertThrows<IllegalStateException> { client.callTool("observe", emptyMap()) }
  }

  @Test
  fun `callTool sends the tool name and nested parameters to the daemon and returns the result`() {
    val daemon = FakeDaemon(ok("""{"content":[{"type":"text","text":"done"}]}"""))
    val client = client(daemon)

    val result =
      client.callTool(
        "tapOn",
        mapOf("selector" to mapOf("text" to "OK"), "action" to "longPress", "duration" to 800),
      )

    assertEquals("""{"content":[{"type":"text","text":"done"}]}""", result)
    val (name, arguments) = daemon.calls.single()
    assertEquals("tapOn", name)
    assertEquals(JsonPrimitive("OK"), arguments.getValue("selector").jsonObject["text"])
    assertEquals(JsonPrimitive("longPress"), arguments["action"])
    assertEquals(JsonPrimitive(800), arguments["duration"])
  }

  @Test
  fun `an isError tool result is thrown with its text instead of returned as success`() {
    val daemon =
      FakeDaemon(ok("""{"isError":true,"content":[{"type":"text","text":"bad selector"}]}"""))

    val error = assertThrows<RuntimeException> { client(daemon).callTool("tapOn", emptyMap()) }

    assertTrue(error.message!!.contains("bad selector"), error.message)
  }

  @Test
  fun `a daemon failure response is thrown with the daemon error`() {
    val daemon = FakeDaemon(DaemonResponse("1", "mcp_response", false, error = "no device"))

    val error = assertThrows<RuntimeException> { client(daemon).callTool("observe", emptyMap()) }

    assertTrue(error.message!!.contains("no device"), error.message)
  }

  @Test
  fun `a daemon transport failure names the tool`() {
    val daemon =
      object : AutoMobileAgent.DaemonToolCaller {
        override fun call(
          toolName: String,
          arguments: JsonObject,
          timeoutMs: Long,
        ): DaemonResponse = throw DaemonUnavailableException("socket closed")
      }

    val error =
      assertThrows<RuntimeException> {
        AutoMobileAgent.DefaultMCPClient(daemon, FakeConnectivity()).run {
          connect("x")
          callTool("observe", emptyMap())
        }
      }

    assertTrue(error.message!!.contains("observe") && error.message!!.contains("socket closed"))
  }
}
