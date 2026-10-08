package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.junit.Test

class McpDaemonClientObserveErrorTest {
  @Test
  fun `observe tool error propagates connection exception`() {
    val client =
      clientWithResult("""{"content":[{"type":"text","text":"Error: no device"}],"isError":true}""")

    val error = assertFailsWith<McpConnectionException> { client.observe("android") }

    assertTrue(error.message.orEmpty().contains("no device"))
  }

  @Test
  fun `malformed observe payload becomes connection exception`() {
    val client = clientWithResult("""{"content":[{"type":"text","text":"not json"}]}""")

    val error = assertFailsWith<McpConnectionException> { client.observe("android") }

    assertTrue(error.message.orEmpty().contains("Failed to decode observe response"))
    assertTrue(error.cause is IllegalArgumentException)
  }

  @Test
  fun `well formed observe response still decodes`() {
    val client = clientWithResult("""{"content":[{"type":"text","text":"{\"rotation\":1}"}]}""")

    assertEquals(ObserveResult(rotation = 1), client.observe("android"))
  }

  private fun clientWithResult(result: String): McpDaemonClient =
    McpDaemonClient(
      requestTransport =
        DaemonRequestTransport { request ->
          assertEquals("tools/call", request.method)
          DaemonResponse(
            id = request.id,
            type = "mcp_response",
            success = true,
            result = DaemonJson.parseToJsonElement(result),
          )
        },
    )
}
