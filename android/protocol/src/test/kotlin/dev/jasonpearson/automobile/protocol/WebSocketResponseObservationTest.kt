package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test

class WebSocketResponseObservationTest : WebSocketResponseTestSupport() {
  @Test
  fun `serialize error response without requestId emits null`() {
    val response: WebSocketResponse = ErrorResponse(timestamp = 1234567890L, error = "boom")

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"error""""))
    assertTrue(encoded.contains(""""requestId":null"""))
    assertTrue(encoded.contains(""""success":false"""))
    assertTrue(encoded.contains(""""error":"boom""""))
  }

  @Test
  fun `error response round-trips through sealed serializer`() {
    val original: WebSocketResponse =
      ErrorResponse(timestamp = 42L, requestId = "r1", error = "nope")
    val encoded = json.encodeToString(WebSocketResponse.serializer(), original)
    val decoded = json.decodeFromString(WebSocketResponse.serializer(), encoded)
    assertTrue(decoded is ErrorResponse, "expected ErrorResponse, was ${decoded::class.simpleName}")
    val error = decoded as ErrorResponse
    assertEquals("r1", error.requestId)
    assertFalse(error.success)
    assertEquals("nope", error.error)
  }

  @Test
  fun `serialize launch_intent_result`() {
    val response: WebSocketResponse =
      LaunchIntentResult(
        timestamp = 1234567890L,
        requestId = "li-1",
        success = true,
        packageName = "com.example.app",
        componentName = "com.example.app/.MainActivity",
        totalTimeMs = 3L,
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"launch_intent_result""""))
    assertTrue(encoded.contains(""""componentName":"com.example.app/.MainActivity""""))
    assertTrue(encoded.contains(""""packageName":"com.example.app""""))
  }

  @Test
  fun `serialize frame_metrics_event`() {
    val response: WebSocketResponse =
      FrameMetricsEventResponse(
        timestamp = 1234567890L,
        frameMetrics =
          FrameMetricsData(
            applicationId = "com.example.app",
            fps = 59.5,
            frameTimeMs = 16.8,
            jankFrames = 2,
            totalFrames = 58,
          ),
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"frame_metrics_event""""))
    assertTrue(encoded.contains(""""applicationId":"com.example.app""""))
    assertTrue(encoded.contains(""""fps":59.5"""))
    assertTrue(encoded.contains(""""jankFrames":2"""))
    assertTrue(encoded.contains(""""totalFrames":58"""))

    val decoded = json.decodeFromString(WebSocketResponse.serializer(), encoded)
    assertTrue(decoded is FrameMetricsEventResponse)
    assertEquals(59.5, (decoded as FrameMetricsEventResponse).frameMetrics.fps)
  }

  @Test
  fun `frame_metrics_event round-trips a no-frame window`() {
    val response: WebSocketResponse =
      FrameMetricsEventResponse(
        timestamp = 1L,
        frameMetrics = FrameMetricsData(applicationId = "com.example.app", totalFrames = 0),
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)
    val decoded =
      json.decodeFromString(WebSocketResponse.serializer(), encoded) as FrameMetricsEventResponse

    assertEquals(0, decoded.frameMetrics.totalFrames)
    assertEquals(null, decoded.frameMetrics.fps)
    assertEquals(null, decoded.frameMetrics.jankFrames)
  }

  @Test
  fun `prototype result missing assets round trip and are omitted when absent`() {
    val literal =
      """{"type":"prototype_result","timestamp":42,"requestId":"r1","success":true,"error":null,"missingAssets":["hero","logo"]}"""
    val decoded = assertIs<PrototypeResult>(json.decodeFromString<WebSocketResponse>(literal))
    assertEquals(listOf("hero", "logo"), decoded.missingAssets)
    assertEquals(literal, json.encodeToString<WebSocketResponse>(decoded))
    // Peers that predate the field: it decodes as absent and is never written back as null.
    val legacy = """{"type":"prototype_result","timestamp":42,"requestId":"r1","success":true}"""
    val legacyDecoded = assertIs<PrototypeResult>(json.decodeFromString<WebSocketResponse>(legacy))
    assertNull(legacyDecoded.missingAssets)
    assertFalse(json.encodeToString<WebSocketResponse>(legacyDecoded).contains("missingAssets"))
  }

  @Test
  fun `prototype appearance round trips in a show result, a status entry and an event`() {
    val appearance = """{"mode":"dark","source":"override","deviceDark":false}"""
    val shown =
      """{"type":"prototype_result","timestamp":42,"requestId":"r1","success":true,"error":null,"appearance":$appearance}"""
    val result = assertIs<PrototypeResult>(json.decodeFromString<WebSocketResponse>(shown))
    assertEquals(
      PrototypeAppearance(
        PrototypeAppearanceMode.DARK,
        PrototypeAppearanceSource.OVERRIDE,
        deviceDark = false,
      ),
      result.appearance,
    )
    assertEquals(shown, json.encodeToString<WebSocketResponse>(result))
    val status =
      """{"type":"prototype_result","timestamp":42,"requestId":"r2","success":true,"error":null,"prototypes":[{"id":"panel","persistent":false,"state":{},"pages":{},"lastSequence":3,"appearance":$appearance}],"droppedEvents":0}"""
    val inspected = assertIs<PrototypeResult>(json.decodeFromString<WebSocketResponse>(status))
    assertEquals(result.appearance, inspected.prototypes?.single()?.appearance)
    assertEquals(status, json.encodeToString<WebSocketResponse>(inspected))
    val event =
      """{"type":"prototype_event","timestamp":42,"id":"panel","sequence":4,"kind":"appearance_changed","name":null,"payload":{"mode":"light","source":"system"},"state":{},"pages":{}}"""
    val changed = assertIs<PrototypeEvent>(json.decodeFromString<WebSocketResponse>(event))
    assertEquals(PrototypeEventKind.APPEARANCE_CHANGED, changed.kind)
    assertEquals(event, json.encodeToString<WebSocketResponse>(changed))
  }

  @Test
  fun `prototype appearance names every source and is omitted by older peers`() {
    assertEquals(
      listOf("explicit", "override", "roleLuminance", "authoredBackground", "system"),
      PrototypeAppearanceSource.entries.map {
        json.encodeToString(PrototypeAppearanceSource.serializer(), it).trim('"')
      },
    )
    val legacy =
      """{"type":"prototype_result","timestamp":42,"requestId":"r2","success":true,"prototypes":[{"id":"panel","persistent":false,"state":{},"lastSequence":3}]}"""
    val decoded = assertIs<PrototypeResult>(json.decodeFromString<WebSocketResponse>(legacy))
    assertNull(decoded.appearance)
    assertNull(decoded.prototypes?.single()?.appearance)
    assertFalse(json.encodeToString<WebSocketResponse>(decoded).contains("appearance"))
  }

  @Test
  fun `prototype result echoes request id and event has no request id`() {
    val resultLiteral =
      """{"type":"prototype_result","timestamp":42,"requestId":"r1","success":false,"error":"prototype host not wired"}"""
    val result = json.decodeFromString<WebSocketResponse>(resultLiteral)
    assertEquals("r1", assertIs<PrototypeResult>(result).requestId)
    assertEquals(resultLiteral, json.encodeToString<WebSocketResponse>(result))
    val eventLiteral =
      """{"type":"prototype_event","timestamp":42,"id":"panel","sequence":1,"kind":"emit","name":"next","payload":{"nested":[true,null]},"state":{"label":"Next","enabled":true},"pages":{"pager":0}}"""
    val event = assertIs<PrototypeEvent>(json.decodeFromString<WebSocketResponse>(eventLiteral))
    assertEquals(PrototypeEventKind.EMIT, event.kind)
    assertEquals(1L, event.sequence)
    assertEquals(mapOf("pager" to 0), event.pages)
    assertEquals(eventLiteral, json.encodeToString<WebSocketResponse>(event))
    assertFalse(json.encodeToString<WebSocketResponse>(event).contains("requestId"))
    for (kind in listOf("page_changed", "dismissed")) {
      val literal =
        """{"type":"prototype_event","timestamp":42,"id":"panel","sequence":2,"kind":"$kind","name":null,"payload":null,"state":{},"pages":{}}"""
      assertEquals(
        literal,
        json.encodeToString<WebSocketResponse>(json.decodeFromString<WebSocketResponse>(literal)),
      )
    }
    assertFailsWith<SerializationException> {
      json.decodeFromString<WebSocketResponse>(eventLiteral.replace("emit", "unknown"))
    }
  }
}
