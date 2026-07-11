package dev.jasonpearson.automobile.junit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ParseListToolsResponseTest {

  private val client = AutoMobileAgent.DefaultMCPClient()

  /**
   * A well-formed response with no error but a null result must produce an actionable message, not
   * a misleading NPE from `result!!` (#3607).
   */
  @Test
  fun `null result throws an actionable error`() {
    try {
      client.parseListToolsResponse(AutoMobileAgent.MCPResponse(result = null, error = null))
      fail("expected an exception")
    } catch (e: RuntimeException) {
      assertTrue("message was: ${e.message}", e.message!!.contains("no result"))
    }
  }

  @Test
  fun `an error field is surfaced`() {
    try {
      client.parseListToolsResponse(AutoMobileAgent.MCPResponse(error = JsonPrimitive("boom")))
      fail("expected an exception")
    } catch (e: RuntimeException) {
      assertTrue("message was: ${e.message}", e.message!!.contains("boom"))
    }
  }

  @Test
  fun `a valid result parses to the tools list`() {
    val result = Json.parseToJsonElement("""{"tools":[]}""")
    val tools = client.parseListToolsResponse(AutoMobileAgent.MCPResponse(result = result))
    assertTrue(tools.isEmpty())
  }
}
