package dev.jasonpearson.automobile.junit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionLossGuardMCPClientTest {
  @Test
  fun `calls pass through while the session is held`() {
    val delegate = GuardRecordingClient()
    val client = SessionLossGuardMCPClient(delegate, "held") { null }

    assertEquals("ok", client.callTool("observe", emptyMap()))
    assertEquals(listOf("observe"), delegate.calls)
  }

  @Test
  fun `a released session fails the call fast with the daemon's reason and never waits`() {
    val delegate = GuardRecordingClient()
    var loss: DaemonSessionLoss? = null
    val sleeps = mutableListOf<Long>()
    val client =
      HeldDeviceWaitingMCPClient(
        SessionLossGuardMCPClient(delegate, "held") { loss },
        backoffDelayMs = { _, _ -> 10L },
        sleeper = { sleeps.add(it) },
      )

    client.callTool("observe", emptyMap())
    loss = DaemonSessionLoss("held", "idle", "Session not found: held")

    val error =
      assertThrows(IllegalStateException::class.java) {
        client.callTool("tapOn", mapOf("text" to "OK"))
      }
    assertTrue(error.message.orEmpty().contains("releaseReason: idle"))
    assertEquals("the device is never driven after the release", listOf("observe"), delegate.calls)
    assertTrue(sleeps.isEmpty())
  }
}

private class GuardRecordingClient : AutoMobileAgent.MCPClient {
  val calls = mutableListOf<String>()

  override fun isConnected() = true

  override fun connect(serverUrl: String) = Unit

  override fun disconnect() = Unit

  override fun callTool(toolName: String, parameters: Map<String, Any>): String {
    calls.add(toolName)
    return "ok"
  }

  override fun listAvailableTools(): List<AutoMobileAgent.MCPToolDefinition> = emptyList()
}
