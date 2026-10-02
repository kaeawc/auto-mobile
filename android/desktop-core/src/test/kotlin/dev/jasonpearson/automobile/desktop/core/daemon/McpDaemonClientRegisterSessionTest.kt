package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.decodeFromJsonElement

class McpDaemonClientRegisterSessionTest {
  private val sessionId = "00000000-0000-4000-8000-000000000001"

  @Test
  fun `registration request and result round trip`() {
    val request = RegisterSessionRequest(sessionId, "desktop")
    assertEquals(
      request,
      DaemonJson.decodeFromString<RegisterSessionRequest>(DaemonJson.encodeToString(request)),
    )
    val result = RegisterSessionResult(true, 10000L, 12345L)
    assertEquals(
      result,
      DaemonJson.decodeFromString<RegisterSessionResult>(DaemonJson.encodeToString(result)),
    )
  }

  @Test
  fun `registration sends daemon method and decodes result without device binding`() {
    val transport = FakeRegistrationTransport()
    val client = McpDaemonClient(requestTransport = transport)
    assertEquals(
      RegisterSessionResult(true, 10000L, 12345L),
      client.registerSession(sessionId, "desktop"),
    )
    val request = transport.requests.single()
    assertEquals("daemon/registerSession", request.method)
    assertEquals("mcp_request", request.type)
    assertEquals(
      RegisterSessionRequest(sessionId, "desktop"),
      DaemonJson.decodeFromJsonElement<RegisterSessionRequest>(request.params),
    )
    assertEquals(null, client.sessionUuid)
    assertEquals(setOf("sessionId", "clientName"), request.params.keys)
  }

  @Test
  fun `quota error preserves actionable daemon error`() {
    val error =
      "Observer session limit (32) reached; release a session or wait for heartbeat expiry before retrying"
    val client = McpDaemonClient(requestTransport = FakeRegistrationTransport(error))
    assertEquals(
      error,
      assertFailsWith<DaemonUnavailableException> { client.registerSession(sessionId, "desktop") }
        .message,
    )
  }

  private class FakeRegistrationTransport(private val error: String? = null) :
    DaemonRequestTransport {
    val requests = mutableListOf<DaemonRequest>()

    override fun send(request: DaemonRequest): DaemonResponse {
      requests.add(request)
      // Exercise the same wire decoder as the production socket, without I/O or sleeps.
      val result =
        if (error == null) """{"accepted":true,"heartbeatTimeoutMs":10000,"expiresAtMs":12345}"""
        else "null"
      return DaemonResponse(
          id = request.id,
          type = "mcp_response",
          success = error == null,
          result = DaemonJson.parseToJsonElement(result),
          error = error,
        )
        .let { DaemonJson.decodeFromString(DaemonJson.encodeToString(it)) }
    }
  }
}
