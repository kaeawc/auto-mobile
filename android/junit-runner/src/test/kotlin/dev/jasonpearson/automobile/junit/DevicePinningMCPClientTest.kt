package dev.jasonpearson.automobile.junit

import kotlin.test.assertEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue
import org.junit.jupiter.api.Test

/** Recovery tool calls must target the device the failed step ran on (#10089). */
class DevicePinningMCPClientTest {

  private class RecordingClient : AutoMobileAgent.MCPClient {
    val calls = mutableListOf<Pair<String, Map<String, Any>>>()

    override fun isConnected() = true

    override fun connect(serverUrl: String) = Unit

    override fun disconnect() = Unit

    override fun callTool(toolName: String, parameters: Map<String, Any>): String {
      calls += toolName to parameters
      return "{}"
    }

    override fun listAvailableTools() = emptyList<AutoMobileAgent.MCPToolDefinition>()
  }

  @Test
  fun `every call carries the failed step's device id`() {
    val delegate = RecordingClient()
    val pinned = DevicePinningMCPClient(delegate, "emulator-5556")

    pinned.callTool("tapOn", mapOf("selector" to mapOf("text" to "OK")))
    pinned.callTool("pressButton", mapOf("button" to "back"))

    assertEquals(
      listOf(
        "tapOn" to mapOf("selector" to mapOf("text" to "OK"), "deviceId" to "emulator-5556"),
        "pressButton" to mapOf("button" to "back", "deviceId" to "emulator-5556"),
      ),
      delegate.calls,
    )
  }

  @Test
  fun `a raw observe is sent as project full because deviceId reads reject raw`() {
    val delegate = RecordingClient()

    DevicePinningMCPClient(delegate, "emulator-5556").callTool("observe", mapOf("raw" to true))

    assertEquals(
      mapOf("project" to "full", "deviceId" to "emulator-5556"),
      delegate.calls[0].second,
    )
  }

  @Test
  fun `a call that already names its target is forwarded unchanged`() {
    val delegate = RecordingClient()
    val pinned = DevicePinningMCPClient(delegate, "emulator-5556")
    val bySession = mapOf<String, Any>("sessionUuid" to "s-1", "raw" to true)
    val byLabel = mapOf<String, Any>("device" to "A")

    pinned.callTool("observe", bySession)
    pinned.callTool("tapAt", byLabel)

    assertEquals(listOf(bySession, byLabel), delegate.calls.map { it.second })
  }

  @Test
  fun `an unknown device id leaves the client unpinned`() {
    val delegate = RecordingClient()

    assertSame(delegate, DevicePinningMCPClient.pinTo(delegate, null))
    assertSame(delegate, DevicePinningMCPClient.pinTo(delegate, " "))
    assertTrue(DevicePinningMCPClient.pinTo(delegate, "emulator-5554") is DevicePinningMCPClient)
  }
}
