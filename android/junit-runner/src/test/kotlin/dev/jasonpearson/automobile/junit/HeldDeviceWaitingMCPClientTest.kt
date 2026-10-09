package dev.jasonpearson.automobile.junit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class HeldDeviceWaitingMCPClientTest {
  private class ScriptedClient(private val script: MutableList<() -> String>) :
    AutoMobileAgent.MCPClient {
    var calls = 0

    override fun isConnected() = true

    override fun connect(serverUrl: String) = Unit

    override fun disconnect() = Unit

    override fun callTool(toolName: String, parameters: Map<String, Any>): String {
      calls++
      return script.removeAt(0)()
    }

    override fun listAvailableTools(): List<AutoMobileAgent.MCPToolDefinition> = emptyList()
  }

  private fun refusal(code: String): () -> String = {
    throw RuntimeException(
      "MCP tool observe returned an error: {\"code\":\"$code\",\"retryable\":false}",
    )
  }

  private val sleeps = mutableListOf<Long>()

  private fun client(delegate: AutoMobileAgent.MCPClient, budgetMs: Long = 30_000L) =
    HeldDeviceWaitingMCPClient(
      delegate,
      backoffDelayMs = { waits, waited ->
        val remaining = budgetMs - waited
        if (remaining <= 0) null else minOf(500L shl waits, 4_000L, remaining)
      },
      sleeper = { sleeps += it },
    )

  @Test
  fun `first call waits while another runner holds the device then succeeds`() {
    val delegate =
      ScriptedClient(
        mutableListOf(
          refusal("device_owned_by_other_session"),
          refusal("device_cleanup_in_progress"),
          { "ok" },
        ),
      )

    assertEquals("ok", client(delegate).callTool("observe", emptyMap()))
    assertEquals(3, delegate.calls)
    assertEquals(listOf(500L, 1_000L), sleeps)
  }

  @Test
  fun `waiting is bounded and the last refusal surfaces`() {
    val delegate = ScriptedClient(MutableList(50) { refusal("device_owned_by_other_session") })

    try {
      client(delegate, budgetMs = 3_000L).callTool("observe", emptyMap())
      fail("expected the refusal once the budget is spent")
    } catch (error: RuntimeException) {
      assertTrue(error.message!!.contains("device_owned_by_other_session"))
    }
    assertEquals(3_000L, sleeps.sum())
  }

  @Test
  fun `calls after the first success pass straight through without waiting`() {
    val delegate =
      ScriptedClient(mutableListOf({ "ok" }, refusal("device_owned_by_other_session")))
    val client = client(delegate)

    assertEquals("ok", client.callTool("observe", emptyMap()))
    try {
      client.callTool("tapOn", emptyMap())
      fail("a later refusal is not waited for")
    } catch (_: RuntimeException) {}
    assertTrue(sleeps.isEmpty())
  }

  @Test
  fun `an idle-released held session is a clear failure not a wait`() {
    val delegate = ScriptedClient(mutableListOf(refusal("session_ownership_lost")))

    try {
      client(delegate).callTool("observe", emptyMap())
      fail("expected failure")
    } catch (error: RuntimeException) {
      assertTrue(error.message!!.contains("idle window"))
    }
    assertEquals(1, delegate.calls)
    assertFalse(sleeps.isNotEmpty())
  }
}
