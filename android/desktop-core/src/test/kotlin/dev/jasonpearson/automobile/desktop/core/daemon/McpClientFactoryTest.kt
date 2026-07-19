package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import org.junit.After
import org.junit.Test

/** Covers [McpClientFactory] configuration resolution and endpoint normalization. */
class McpClientFactoryTest {

  private val touchedProperties = mutableListOf<String>()

  @After
  fun tearDown() {
    touchedProperties.forEach { System.clearProperty(it) }
    touchedProperties.clear()
  }

  private fun setProperty(key: String, value: String) {
    touchedProperties.add(key)
    System.setProperty(key, value)
  }

  @Test
  fun `http url comes from the automobile mcp http url property`() {
    setProperty("automobile.mcp.httpUrl", "http://localhost:4100")

    val client = assertNotNull(McpClientFactory.createConfiguredHttp())

    assertEquals("http://localhost:4100/auto-mobile/streamable", client.connectionDescription)
  }

  @Test
  fun `blank configuration is treated as unset`() {
    setProperty("automobile.mcp.httpUrl", "   ")

    assertNull(McpClientFactory.createConfiguredHttp())
  }

  @Test
  fun `stdio command comes from the automobile mcp stdio command property`() {
    setProperty("automobile.mcp.stdioCommand", "auto-mobile --stdio")

    val client = assertNotNull(McpClientFactory.createConfiguredStdio())

    assertEquals("auto-mobile --stdio", client.connectionDescription)
  }

  @Test
  fun `no configuration yields no configured client`() {
    assertNull(McpClientFactory.createConfiguredHttp())
    assertNull(McpClientFactory.createConfiguredStdio())
  }

  @Test
  fun `bare host is normalized to the streamable endpoint`() {
    assertEquals(
      "http://localhost:3000/auto-mobile/streamable",
      McpClientFactory.normalizeHttpUrl("http://localhost:3000"),
    )
  }

  @Test
  fun `trailing slash is normalized away`() {
    assertEquals(
      "http://localhost:3000/auto-mobile/streamable",
      McpClientFactory.normalizeHttpUrl("http://localhost:3000/"),
    )
  }

  @Test
  fun `an already-qualified streamable endpoint is left alone`() {
    assertEquals(
      "http://localhost:3000/auto-mobile/streamable",
      McpClientFactory.normalizeHttpUrl("http://localhost:3000/auto-mobile/streamable"),
    )
  }

  @Test
  fun `an sse endpoint is preserved`() {
    assertEquals(
      "http://localhost:3000/auto-mobile/sse",
      McpClientFactory.normalizeHttpUrl("http://localhost:3000/auto-mobile/sse"),
    )
  }

  @Test
  fun `the auto-mobile base path gains the streamable suffix`() {
    assertEquals(
      "http://localhost:3000/auto-mobile/streamable",
      McpClientFactory.normalizeHttpUrl("http://localhost:3000/auto-mobile"),
    )
  }
}
