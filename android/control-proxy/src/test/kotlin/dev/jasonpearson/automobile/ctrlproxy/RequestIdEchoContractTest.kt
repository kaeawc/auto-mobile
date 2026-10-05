package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.elementDescriptors
import kotlinx.serialization.descriptors.elementNames
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure protocol checks: a new response must explicitly choose correlation or unsolicited delivery.
 */
class RequestIdEchoContractTest {
  // These are unsolicited events or the initial handshake, never replies to a request. The mixed
  // hierarchy_update and error types are deliberately excluded: their descriptors must carry an
  // optional requestId even though unsolicited pushes / unextractable decode failures omit it.
  private val idLessEvents =
    setOf(
      "connected",
      "interaction_event",
      "package_event",
      "navigation_event",
      "handled_exception_event",
      "network_event",
      "websocket_frame_event",
      "log_event",
      "broadcast_event",
      "lifecycle_event",
      "frame_metrics_event",
      "storage_changed",
      "crash_event",
      "anr_event",
      "overlay_event",
    )

  @Test
  fun `every response either echoes requestId or is an explicitly allowed event`() {
    val descriptor = WebSocketResponse.serializer().descriptor
    val subtypes = descriptor.getElementDescriptor(descriptor.getElementIndex("value"))
    val responses = subtypes.elementDescriptors.toList()
    assertTrue("The sealed response contract must be nonempty", responses.isNotEmpty())
    for (response in responses) {
      assertTrue(
        "${response.serialName} must carry requestId or be an explicitly documented event",
        response.serialName in idLessEvents || "requestId" in response.elementNames,
      )
    }
    // Keep the allow-list honest too: removed events or newly correlated events need a decision.
    assertEquals(
      idLessEvents,
      responses.filterNot { "requestId" in it.elementNames }.map { it.serialName }.toSet(),
    )
  }

  @Test
  fun `decode failure frame echoes the extractable requestId on the wire`() {
    val raw = """{"type":"totally_unknown_command","requestId":"decode-echo"}"""
    val failure = SerializationException("Unknown polymorphic command")
    // These are the same Android-free seams composed by handleClientMessage's decode catch.
    val response =
      CorrelatedErrorReporter.frame(
        requestId = WebSocketServer.extractRequestId(raw),
        errorMessage = WebSocketServer.describeDecodeFailure(raw, failure),
      )
    assertEquals("decode-echo", response.requestId)
    assertEquals("Unknown command type: totally_unknown_command", response.error)
    val encoded = Json.encodeToString(WebSocketResponse.serializer(), response)
    val decoded = Json.decodeFromString(WebSocketResponse.serializer(), encoded)
    assertTrue(decoded is ErrorResponse)
    assertEquals("decode-echo", (decoded as ErrorResponse).requestId)
  }
}
