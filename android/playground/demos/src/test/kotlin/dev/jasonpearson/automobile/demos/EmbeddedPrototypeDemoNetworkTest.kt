package dev.jasonpearson.automobile.demos

import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeEventKind
import dev.jasonpearson.automobile.protocol.PrototypeRequestError
import dev.jasonpearson.automobile.protocol.PrototypeRequestErrorCode
import dev.jasonpearson.automobile.protocol.PrototypeRequestEvent
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import dev.jasonpearson.automobile.protocol.PrototypeRequests
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EmbeddedPrototypeDemoNetworkTest {
  @Test
  fun greetingRequestFromTheBundledSpecSucceeds() {
    val response =
      EmbeddedPrototypeDemoTransport.respond("GET", "http://10.0.2.2:8080/greeting")
        as PrototypeRequestResponse.Received
    assertTrue(response.isSuccessful)
    assertEquals(
      buildJsonObject { put("text", EmbeddedPrototypeDemoTransport.GREETING_TEXT) },
      response.body,
    )
  }

  @Test
  fun otherRequestsFailWithATypedError() {
    val response =
      EmbeddedPrototypeDemoTransport.respond("POST", "http://10.0.2.2:8080/greeting")
        as PrototypeRequestResponse.Failed
    assertEquals(PrototypeRequestErrorCode.NOT_FOUND, response.error.code)
    val unknown =
      EmbeddedPrototypeDemoTransport.respond("GET", "not a url {")
        as PrototypeRequestResponse.Failed
    assertEquals(PrototypeRequestErrorCode.NOT_FOUND, unknown.error.code)
  }

  @Test
  fun failedRequestEventShowsCodeAndMessage() {
    val error = PrototypeRequestError(PrototypeRequestErrorCode.NETWORK, "offline")
    assertEquals(
      "Request failed (network): offline",
      EmbeddedPrototypeRequestStatus.messageFor(requestEvent(error)),
    )
  }

  @Test
  fun succeededRequestEventClearsTheError() {
    assertEquals("", EmbeddedPrototypeRequestStatus.messageFor(requestEvent(error = null)))
  }

  @Test
  fun unrelatedEventsLeaveTheStatusAlone() {
    assertNull(
      EmbeddedPrototypeRequestStatus.messageFor(
        event(PrototypeEventKind.EMIT, "custom", JsonPrimitive(1)),
      ),
    )
    assertNull(
      EmbeddedPrototypeRequestStatus.messageFor(
        event(PrototypeEventKind.CHANGE, PrototypeRequests.EVENT_NAME, null),
      ),
    )
  }

  private fun requestEvent(error: PrototypeRequestError?) =
    event(
      PrototypeEventKind.EMIT,
      PrototypeRequests.EVENT_NAME,
      PrototypeRequestEvent.payload(
        requestId = "r1",
        method = "GET",
        url = "http://10.0.2.2:8080/greeting",
        via = "device",
        into = "/data/greeting",
        status = if (error == null) 200 else null,
        durationMs = 0L,
        error = error,
      ),
    )

  private fun event(kind: PrototypeEventKind, name: String?, payload: JsonElement?) =
    PrototypeEvent(
      timestamp = 0L,
      id = "embeddingSample",
      sequence = 1L,
      kind = kind,
      name = name,
      payload = payload,
      state = emptyMap(),
    )
}
