package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

class McpDaemonClientHandshakeTest {

  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `daemon request serializes clientVersion for the handshake`() {
    val request =
        DaemonRequest(
            id = "req-1",
            type = "mcp_request",
            method = "ide/ping",
            params = JsonObject(emptyMap()),
            clientVersion = "0.0.40",
        )
    val encoded = json.encodeToString(request)
    assertTrue(
        encoded.contains("\"clientVersion\":\"0.0.40\""),
        "payload should carry clientVersion",
    )
  }

  @Test
  fun `daemon request omits clientVersion when null`() {
    val request =
        DaemonRequest(
            id = "req-1",
            type = "mcp_request",
            method = "ide/ping",
            params = JsonObject(emptyMap()),
        )
    val encoded = json.encodeToString(request)
    assertFalse(
        encoded.contains("clientVersion"),
        "legacy payload should not carry clientVersion",
    )
  }
}
