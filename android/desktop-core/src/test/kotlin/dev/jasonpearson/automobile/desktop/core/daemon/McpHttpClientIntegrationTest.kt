package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Before
import org.junit.Test

/** Integration tests for [McpHttpClient] using [TestDaemonInstance] as a fake MCP server. */
class McpHttpClientIntegrationTest {

  private lateinit var daemon: TestDaemonInstance
  private lateinit var client: McpHttpClient

  @Before
  fun setUp() {
    daemon = TestDaemonInstance()
    val port = daemon.start()
    client = McpHttpClient("http://localhost:$port/auto-mobile/streamable")
  }

  @After
  fun tearDown() {
    daemon.stop()
  }

  /** Build an MCP tool response wrapping the given JSON text. */
  private fun mcpToolResponse(textJson: String, isError: Boolean = false): JsonElement =
    buildJsonObject {
      if (isError) put("isError", true)
      put(
        "content",
        buildJsonArray {
          add(
            buildJsonObject {
              put("type", "text")
              put("text", textJson)
            }
          )
        },
      )
    }

  @Test
  fun `ping initializes session and records calls`() {
    client.ping()

    assertTrue(daemon.calls.contains("initialize"), "Should have called initialize")
    assertTrue(
      daemon.calls.contains("notifications/initialized"),
      "Should have sent initialized notification",
    )
  }

  @Test
  fun `ping only initializes once`() {
    client.ping()
    client.ping()

    val initCount = daemon.calls.count { it == "initialize" }
    assertEquals(1, initCount, "Should only initialize once")
  }

  @Test
  fun `listTools returns configured tools`() {
    daemon.addTool(McpTool(name = "observe", description = "Capture screen state"))
    daemon.addTool(McpTool(name = "tapOn", description = "Tap on element"))

    val tools = client.listTools()

    assertEquals(2, tools.size)
    assertEquals("observe", tools[0].name)
    assertEquals("tapOn", tools[1].name)
    assertTrue(daemon.calls.contains("tools/list"))
  }

  @Test
  fun `callTool sends correct request and returns response`() {
    daemon.setToolResponse("observe", mcpToolResponse("""{"success":true}"""))

    val result = client.callTool("observe", buildJsonObject { put("platform", "android") })

    assertNotNull(result)
    assertTrue(daemon.calls.contains("tools/call:observe"))
  }

  @Test
  fun `listResources returns configured resources`() {
    daemon.addResource(
      McpResource(uri = "automobile://devices", name = "devices", description = "List devices")
    )

    val resources = client.listResources()

    assertEquals(1, resources.size)
    assertEquals("automobile://devices", resources[0].uri)
    assertTrue(daemon.calls.contains("resources/list"))
  }

  @Test
  fun `readResource returns configured content`() {
    val uri = "automobile://devices"
    daemon.setResourceResponse(
      uri,
      listOf(
        McpResourceContent(
          uri = uri,
          mimeType = "application/json",
          text = """{"devices":[]}""",
        )
      ),
    )

    val contents = client.readResource(uri)

    assertEquals(1, contents.size)
    assertEquals(uri, contents[0].uri)
    assertEquals("""{"devices":[]}""", contents[0].text)
    assertTrue(daemon.calls.contains("resources/read"))
  }

  @Test
  fun `observe decodes tool response`() {
    daemon.setToolResponse("observe", mcpToolResponse("""{"updatedAt":1234567890}"""))

    val result = client.observe("android")

    assertEquals(1234567890L, result.updatedAt)
    assertTrue(daemon.calls.contains("tools/call:observe"))
  }

  @Test
  fun `multiple tool calls are recorded in order`() {
    val emptyResponse = mcpToolResponse("{}")
    daemon.setToolResponse("observe", emptyResponse)
    daemon.setToolResponse("getDaemonStatus", emptyResponse)

    client.callTool("observe", JsonObject(emptyMap()))
    client.callTool("getDaemonStatus", JsonObject(emptyMap()))

    val toolCalls = daemon.calls.filter { it.startsWith("tools/call:") }
    assertEquals(listOf("tools/call:observe", "tools/call:getDaemonStatus"), toolCalls)
  }

  @Test
  fun `callTool passes arguments through`() {
    daemon.setToolResponse(
      "startDevice",
      mcpToolResponse("""{"success":true,"message":"started"}"""),
    )

    val result =
      client.startDevice(name = "Pixel_6", platform = "android", deviceId = "emulator-5554")

    assertTrue(result.success)
    assertEquals("started", result.message)
    assertTrue(daemon.calls.contains("tools/call:startDevice"))
  }

  @Test
  fun `typed tool results preserve MCP error envelopes`() {
    daemon.setToolResponse(
      "setActiveDevice",
      mcpToolResponse(
        """{"code":"device_lost","reason":"confirmed-unavailable"}""",
        isError = true,
      ),
    )

    val result = client.setActiveDevice("emulator-5554", "android")

    assertEquals(false, result.success)
    assertEquals("confirmed-unavailable", result.message)
  }
}
