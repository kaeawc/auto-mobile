package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Test

class AttestationContractTest {
  @Test
  fun `attestation request and response preserve wire type and correlation`() {
    val request =
      Json.decodeFromString<WebSocketRequest>("""{"type":"export_attestation","requestId":"a1"}""")
    assertEquals(ExportAttestation("a1"), request)
    val response: WebSocketResponse = AttestationChainResult(1L, "a1", listOf("leaf", "root"))
    val decoded = Json.decodeFromString<WebSocketResponse>(Json.encodeToString(response))
    assertEquals(response, decoded)
    assertEquals("a1", (decoded as CorrelatedResponse).requestId)
  }
}
