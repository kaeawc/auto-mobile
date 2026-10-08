package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Before
import org.junit.Test

/**
 * [McpHttpClient] over a real localhost socket against [TestDaemonInstance], which enforces the MCP
 * SDK's `Accept` rule, answers with `text/event-stream` like the daemon, and answers 404 for an
 * unknown session. The JDK `HttpClient` decodes the body, so this also covers multi-byte characters
 * torn across network reads.
 */
class McpHttpClientStreamableIntegrationTest {
  private lateinit var daemon: TestDaemonInstance
  private lateinit var client: McpHttpClient

  @Before
  fun setUp() {
    daemon = TestDaemonInstance()
    client = McpHttpClient("http://localhost:${daemon.start()}/auto-mobile/streamable")
  }

  @After
  fun tearDown() {
    daemon.stop()
  }

  @Test
  fun `every request carries the Accept header the transport requires`() {
    daemon.addTool(McpTool(name = "observe"))

    client.listTools()

    assertEquals(3, daemon.acceptHeaders.size)
    assertTrue(daemon.acceptHeaders.all { it == "application/json, text/event-stream" })
  }

  @Test
  fun `plain JSON replies work too`() {
    daemon.answerWithEventStream = false
    daemon.addTool(McpTool(name = "observe"))

    assertEquals(listOf("observe"), client.listTools().map { it.name })
  }

  @Test
  fun `a daemon restart is recovered by re-initializing once`() {
    daemon.addTool(McpTool(name = "observe"))
    client.listTools()

    daemon.forgetSessions()
    val tools = client.listTools()

    assertEquals(listOf("observe"), tools.map { it.name })
    assertEquals(2, daemon.calls.count { it == "initialize" })
  }

  @Test
  fun `a multi-byte character split across reads decodes intact`() {
    val text = "café 日本語 🚀"
    daemon.setToolResponse(
      "observe",
      buildJsonObject {
        put(
          "content",
          buildJsonArray {
            add(
              buildJsonObject {
                put("type", "text")
                put("text", text)
              }
            )
          },
        )
      },
    )
    // Flush one byte at a time so every multi-byte sequence straddles separate reads.
    daemon.eventStreamChunker = { bytes -> bytes.map { byteArrayOf(it) } }

    val result = client.callTool("observe", JsonObject(emptyMap()))

    val decoded =
      result.jsonObject
        .getValue("content")
        .jsonArray
        .first()
        .jsonObject
        .getValue("text")
        .jsonPrimitive
        .content
    assertEquals(text, decoded)
  }
}
