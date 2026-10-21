package dev.jasonpearson.automobile.junit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DefaultMCPClientTimeoutTest {
  private val timeouts = mutableListOf<Long>()
  private val daemon = AutoMobileAgent.DaemonToolCaller { _, _, timeoutMs ->
    timeouts += timeoutMs
    DaemonResponse("r", "mcp_response", true)
  }
  private val connectivity =
    object : DaemonConnectivityChecker {
      override fun isDaemonAlive() = true

      override fun waitForDaemon(timeoutMs: Long) = true
    }
  private val client = AutoMobileAgent.DefaultMCPClient(daemon, connectivity)

  @Test
  fun `observe uses the daemon timeout floor`() {
    client.connect("unused")
    client.callTool("observe", emptyMap())

    assertTrue(timeouts.single() >= 90_000L)
  }

  @Test
  fun `launchApp uses the daemon timeout floor`() {
    client.connect("unused")
    client.callTool("launchApp", emptyMap())

    assertTrue(timeouts.single() >= 90_000L)
  }

  @Test
  fun `other tools retain thirty second timeouts`() {
    client.connect("unused")
    listOf("tapOn", "sendKeys", "swipeOn").forEach { client.callTool(it, emptyMap()) }

    assertEquals(listOf(30_000L, 30_000L, 30_000L), timeouts)
  }
}
