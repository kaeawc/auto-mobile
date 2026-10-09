package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class McpDaemonClientMissingResultTest {
  @Test
  fun `list tools without result throws actionable connection exception`() {
    val error = assertFailsWith<DaemonUnavailableException> { clientWithResult(null).listTools() }
    assertTrue(error.message.orEmpty().contains("tools/list response contained no result"))
  }

  @Test
  fun `register session without result throws actionable connection exception`() {
    val error =
      assertFailsWith<DaemonUnavailableException> {
        clientWithResult(null).registerSession("00000000-0000-4000-8000-000000000001", "desktop")
      }
    assertTrue(
      error.message.orEmpty().contains("daemon/registerSession response contained no result"),
    )
  }

  @Test
  fun `well formed list tools response still decodes`() {
    val tools =
      clientWithResult("""{"tools":[{"name":"ping","description":"Ping","inputSchema":{}}]}""")
        .listTools()
    assertEquals(listOf("ping"), tools.map { it.name })
  }

  private fun clientWithResult(result: String?): McpDaemonClient =
    McpDaemonClient(
      requestTransport =
        DaemonRequestTransport { request ->
          DaemonResponse(
            id = request.id,
            type = "mcp_response",
            success = true,
            result = result?.let(DaemonJson::parseToJsonElement),
          )
        },
    )
}
