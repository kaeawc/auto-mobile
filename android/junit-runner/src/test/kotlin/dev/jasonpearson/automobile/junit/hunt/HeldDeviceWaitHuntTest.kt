package dev.jasonpearson.automobile.junit.hunt

import dev.jasonpearson.automobile.junit.AutoMobileAgent
import dev.jasonpearson.automobile.junit.HeldDeviceWaitingMCPClient
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

/** Hunt: AI recovery's held-device wait against real refusal payloads and the reads contract. */
class HeldDeviceWaitHuntTest {
  private class ScriptedClient(private val script: MutableList<(String) -> String>) :
    AutoMobileAgent.MCPClient {
    override fun isConnected() = true

    override fun connect(serverUrl: String) = Unit

    override fun disconnect() = Unit

    override fun callTool(toolName: String, parameters: Map<String, Any>): String =
      script.removeAt(0)(toolName)

    override fun listAvailableTools(): List<AutoMobileAgent.MCPToolDefinition> = emptyList()
  }

  private val sleeps = mutableListOf<Long>()

  private fun client(delegate: AutoMobileAgent.MCPClient) =
    HeldDeviceWaitingMCPClient(
      delegate,
      backoffDelayMs = { waits, waited ->
        if (30_000L - waited <= 0) null else minOf(500L shl waits, 4_000L)
      },
      sleeper = { sleeps += it },
    )

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

  private fun refuse(name: String): (String) -> String = { tool ->
    throw RuntimeException("MCP tool $tool returned an error: ${fixtureText(name)}")
  }

  @Test
  fun `recovery waits out every retryable device refusal the plan loop waits out`() {
    // executePlan waits on all of these (AutoMobilePlanExecutor.waitsForDevice); recovery's first
    // call must not treat the same typed, retryable refusal as fatal.
    val fatal = mutableListOf<String>()
    for (code in listOf("device_shutting_down", "device_owned_by_other_daemon")) {
      val delegate = ScriptedClient(mutableListOf(refuse(code), { "ok" }))
      try {
        client(delegate).callTool("tapOn", emptyMap())
      } catch (_: RuntimeException) {
        fatal += code
      }
    }
    assertEquals("retryable refusals surfaced without waiting: $fatal", emptyList<String>(), fatal)
  }

  @Test
  fun `a successful read does not confirm the device for the control call that follows`() {
    // Reads are never refused and never hold the device, so an observe succeeding proves nothing
    // about ownership; the control call after it still gets the busy refusal and must wait.
    val delegate =
      ScriptedClient(
        mutableListOf({ "observed" }, refuse("device_owned_by_other_session"), { "tapped" }),
      )
    val client = client(delegate)

    assertEquals("observed", client.callTool("observe", emptyMap()))
    assertEquals("tapped", client.callTool("tapOn", emptyMap()))
  }
}
