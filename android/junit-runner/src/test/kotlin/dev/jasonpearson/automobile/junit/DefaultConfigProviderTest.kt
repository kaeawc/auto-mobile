package dev.jasonpearson.automobile.junit

import kotlin.test.assertEquals
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test

class DefaultConfigProviderTest {

  @AfterEach
  fun tearDown() {
    System.clearProperty("automobile.mcp.server.url")
  }

  /**
   * Pre-fix, getMcpServerUrl() passed the URL as the property NAME (1-arg getProperty), so it
   * returned null and AI recovery could never connect (#3596). It must return the default URL when
   * the property is unset.
   */
  @Test
  fun `getMcpServerUrl returns the default url when the property is unset`() {
    System.clearProperty("automobile.mcp.server.url")
    assertEquals(
      "http://localhost:3000",
      AutoMobileAgent.DefaultConfigProvider().getMcpServerUrl(),
    )
  }

  @Test
  fun `getMcpServerUrl returns the override when the property is set`() {
    System.setProperty("automobile.mcp.server.url", "http://10.0.0.5:9000")
    assertEquals(
      "http://10.0.0.5:9000",
      AutoMobileAgent.DefaultConfigProvider().getMcpServerUrl(),
    )
  }
}
