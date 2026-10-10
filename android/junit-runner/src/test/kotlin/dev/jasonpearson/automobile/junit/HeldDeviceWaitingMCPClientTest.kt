package dev.jasonpearson.automobile.junit

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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

  /** The wire text of a real refusal fixture from `test/fixtures/refusal-wire`. */
  private fun fixtureText(name: String): String {
    var current: File? = File("").absoluteFile
    while (current != null) {
      val file = File(current, "test/fixtures/refusal-wire/$name.json")
      if (file.isFile) {
        return Json.parseToJsonElement(file.readText())
          .jsonObject
          .getValue("result")
          .jsonObject
          .getValue("content")
          .jsonArray
          .first()
          .jsonObject
          .getValue("text")
          .jsonPrimitive
          .content
      }
      current = current.parentFile
    }
    error("fixture $name not found")
  }

  private fun fixtureRefusal(name: String): () -> String = {
    throw RuntimeException("MCP tool tapOn returned an error: ${fixtureText(name)}")
  }

  private val sleeps = mutableListOf<Long>()

  private fun client(delegate: AutoMobileAgent.MCPClient, budgetMs: Long = 30_000L) =
    HeldDeviceWaitingMCPClient(
      delegate,
      backoffDelayMs = { waits, waited, retryAfterMs ->
        val remaining = budgetMs - waited
        if (remaining <= 0) {
          null
        } else {
          minOf(maxOf(minOf(500L shl waits, 4_000L), retryAfterMs ?: 0L), remaining)
        }
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
    val delegate = ScriptedClient(mutableListOf({ "ok" }, refusal("device_owned_by_other_session")))
    val client = client(delegate)

    assertEquals("ok", client.callTool("tapOn", emptyMap()))
    try {
      client.callTool("tapOn", emptyMap())
      fail("a later refusal is not waited for")
    } catch (_: RuntimeException) {}
    assertTrue(sleeps.isEmpty())
  }

  @Test
  fun `an idle-released held session is a clear failure not a wait`() {
    val delegate = ScriptedClient(mutableListOf(fixtureRefusal("session_ownership_lost")))

    try {
      client(delegate).callTool("observe", emptyMap())
      fail("expected failure")
    } catch (error: RuntimeException) {
      assertTrue(error.message!!.contains("idle window"))
    }
    assertEquals(1, delegate.calls)
    assertFalse(sleeps.isNotEmpty())
  }

  @Test
  fun `every device refusal the plan loop waits out is waited out and honours retryAfterMs`() {
    val expectedFirstSleep =
      mapOf(
        "device_shutting_down" to 2_000L,
        "device_owned_by_other_daemon" to 2_000L,
        "capacity_exhausted" to 5_000L,
        "discovery_incomplete" to 500L,
        "device_cleanup_in_progress" to 1_000L,
        "device_owned_by_other_session" to 500L,
      )
    for ((code, firstSleep) in expectedFirstSleep) {
      sleeps.clear()
      val delegate = ScriptedClient(mutableListOf(fixtureRefusal(code), { "ok" }))

      assertEquals(code, "ok", client(delegate).callTool("tapOn", emptyMap()))
      assertEquals(code, listOf(firstSleep), sleeps)
    }
  }

  @Test
  fun `terminal and non-wait refusals are never waited on`() {
    val terminal =
      listOf(
        "session_ownership_lost",
        "no_active_device_session",
        "session_terminal_release_in_progress",
        "device_outside_bound_session",
        "daemon_session_suspect",
      )
    for (code in terminal) {
      val delegate = ScriptedClient(mutableListOf(fixtureRefusal(code), { "ok" }))
      try {
        client(delegate).callTool("tapOn", emptyMap())
        fail("$code must surface")
      } catch (_: RuntimeException) {}
      assertEquals(code, 1, delegate.calls)
    }
    assertTrue(sleeps.isEmpty())
  }

  @Test
  fun `a busy code in prose without a typed payload is not waited on`() {
    val delegate =
      ScriptedClient(
        mutableListOf({ throw RuntimeException("device_owned_by_other_session in prose") }),
      )

    try {
      client(delegate).callTool("tapOn", emptyMap())
      fail("expected failure")
    } catch (_: RuntimeException) {}
    assertTrue(sleeps.isEmpty())
  }

  @Test
  fun `a successful read does not confirm the device for the control call that follows`() {
    val delegate =
      ScriptedClient(
        mutableListOf(
          { "observed" },
          fixtureRefusal("device_owned_by_other_session"),
          { "tapped" },
        ),
      )
    val client = client(delegate)

    assertEquals("observed", client.callTool("observe", emptyMap()))
    assertEquals("tapped", client.callTool("tapOn", emptyMap()))
    assertEquals(listOf(500L), sleeps)
  }

  @Test
  fun `a successful lifecycle call confirms the device`() {
    val delegate = ScriptedClient(mutableListOf({ "ok" }, fixtureRefusal("capacity_exhausted")))
    val client = client(delegate)

    assertEquals("ok", client.callTool("launchApp", emptyMap()))
    try {
      client.callTool("tapOn", emptyMap())
      fail("a later refusal is not waited for")
    } catch (_: RuntimeException) {}
    assertTrue(sleeps.isEmpty())
  }
}
