package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test

class WebSocketRequestDeviceTest : WebSocketRequestTestSupport() {
  @Test
  fun `deserialize request_list_keyboard_profiles with negotiated catalog versions`() {
    val request =
      json.decodeFromString<WebSocketRequest>(
        """{"type":"request_list_keyboard_profiles","requestId":"profiles-1","supportedCatalogVersions":[1]}""",
      )

    assertIs<RequestListKeyboardProfiles>(request)
    assertEquals("profiles-1", request.requestId)
    assertEquals(listOf(1), request.supportedCatalogVersions)
  }

  @Test
  fun `deserialize request_hierarchy with filtering disabled`() {
    val message = """{"type":"request_hierarchy","requestId":"test-2","disableAllFiltering":true}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestHierarchy>(request)
    assertEquals("test-2", request.requestId)
    assertEquals(true, request.disableAllFiltering)
  }

  @Test
  fun `deserialize request_hierarchy snapshot limits`() {
    val message =
      """{"type":"request_hierarchy","requestId":"bounded","maxDepth":8,"maxNodes":128}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestHierarchy>(request)
    assertEquals(8, request.maxDepth)
    assertEquals(128, request.maxNodes)
  }

  @Test
  fun `deserialize request_tap_coordinates`() {
    val message = """{"type":"request_tap_coordinates","requestId":"tap-1","x":100,"y":200}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestTapCoordinates>(request)
    assertEquals("tap-1", request.requestId)
    assertEquals(100.0, request.x)
    assertEquals(200.0, request.y)
    assertEquals(10L, request.duration) // default
    assertEquals(false, request.doubleTap)
  }

  @Test
  fun `deserialize atomic double tap opt in`() {
    val request =
      json.decodeFromString<WebSocketRequest>(
        """{"type":"request_tap_coordinates","requestId":"double","x":100,"y":200,"doubleTap":true}""",
      )
    assertIs<RequestTapCoordinates>(request)
    assertEquals(true, request.doubleTap)
  }

  @Test
  fun `deserialize request_tap_coordinates with fractional coordinates`() {
    // Coordinate fields are Double (#2927): a fractional JSON number must decode
    // without a kotlinx decode error and preserve the fraction.
    val message =
      """{"type":"request_tap_coordinates","requestId":"tap-frac","x":100.5,"y":200.25}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestTapCoordinates>(request)
    assertEquals(100.5, request.x)
    assertEquals(200.25, request.y)
  }

  @Test
  fun `deserialize request_swipe`() {
    val message =
      """{"type":"request_swipe","requestId":"swipe-1","x1":0,"y1":100,"x2":0,"y2":500,"duration":400}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestSwipe>(request)
    assertEquals("swipe-1", request.requestId)
    assertEquals(0.0, request.x1)
    assertEquals(100.0, request.y1)
    assertEquals(0.0, request.x2)
    assertEquals(500.0, request.y2)
    assertEquals(400L, request.duration)
  }

  @Test
  fun `deserialize request_swipe with fractional coordinates`() {
    val message =
      """{"type":"request_swipe","requestId":"swipe-frac","x1":0.5,"y1":100.25,"x2":10.75,"y2":500.125,"duration":400}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestSwipe>(request)
    assertEquals(0.5, request.x1)
    assertEquals(100.25, request.y1)
    assertEquals(10.75, request.x2)
    assertEquals(500.125, request.y2)
  }

  @Test
  fun `deserialize request_two_finger_swipe with fractional coordinates`() {
    val message =
      """{"type":"request_two_finger_swipe","requestId":"tfs-frac","x1":0.5,"y1":0.25,"x2":10.75,"y2":20.125,"duration":300,"offset":50}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestTwoFingerSwipe>(request)
    assertEquals(0.5, request.x1)
    assertEquals(0.25, request.y1)
    assertEquals(10.75, request.x2)
    assertEquals(20.125, request.y2)
    assertEquals(50, request.offset) // offset stays Int (pixel offset, not a coordinate)
  }

  @Test
  fun `deserialize request_drag with legacy fields`() {
    val message =
      """{"type":"request_drag","requestId":"drag-1","x1":50,"y1":50,"x2":150,"y2":150,"holdTime":800,"duration":500}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestDrag>(request)
    assertEquals("drag-1", request.requestId)
    assertEquals(50.0, request.x1)
    assertEquals(50.0, request.y1)
    assertEquals(150.0, request.x2)
    assertEquals(150.0, request.y2)
    // Legacy fields are used as fallback
    assertEquals(800L, request.resolvedPressDurationMs)
    assertEquals(500L, request.resolvedDragDurationMs)
  }

  @Test
  fun `deserialize request_drag with fractional coordinates`() {
    val message =
      """{"type":"request_drag","requestId":"drag-frac","x1":50.5,"y1":50.25,"x2":150.75,"y2":150.125}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestDrag>(request)
    assertEquals(50.5, request.x1)
    assertEquals(50.25, request.y1)
    assertEquals(150.75, request.x2)
    assertEquals(150.125, request.y2)
  }

  @Test
  fun `deserialize request_pinch`() {
    val message =
      """{"type":"request_pinch","requestId":"pinch-1","centerX":540,"centerY":960,"distanceStart":100,"distanceEnd":300,"rotationDegrees":45.0,"duration":500}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestPinch>(request)
    assertEquals("pinch-1", request.requestId)
    assertEquals(540.0, request.centerX)
    assertEquals(960.0, request.centerY)
    assertEquals(100.0, request.distanceStart)
    assertEquals(300.0, request.distanceEnd)
    assertEquals(45.0f, request.rotationDegrees)
    assertEquals(500L, request.duration)
  }

  @Test
  fun `deserialize request_pinch with fractional coordinates`() {
    // The iOS-symmetric case (#2927): sub-pixel center + computed fractional distance
    // must decode without a kotlinx decode error and keep the fraction.
    val message =
      """{"type":"request_pinch","requestId":"pinch-frac","centerX":100.5,"centerY":200.25,"distanceStart":80.5,"distanceEnd":120.75,"rotationDegrees":45.0,"duration":500}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestPinch>(request)
    assertEquals(100.5, request.centerX)
    assertEquals(200.25, request.centerY)
    assertEquals(80.5, request.distanceStart)
    assertEquals(120.75, request.distanceEnd)
    assertEquals(45.0f, request.rotationDegrees)
    assertEquals(500L, request.duration)
  }

  @Test
  fun `request_pinch still rejects a missing required coordinate`() {
    // Widening the coordinate fields to Double (#2927) must not weaken required-field decode:
    // they stay non-null with no default, so an absent coordinate is still a decode error.
    val message =
      """{"type":"request_pinch","requestId":"pinch-missing","centerX":100.0,"centerY":200.0,"distanceStart":80.0,"rotationDegrees":45.0,"duration":500}"""
    assertFailsWith<SerializationException> { json.decodeFromString<WebSocketRequest>(message) }
  }

  @Test
  fun `deserialize request_set_text`() {
    val message =
      """{"type":"request_set_text","requestId":"text-1","text":"Hello World","resourceId":"input_field"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestSetText>(request)
    assertEquals("text-1", request.requestId)
    assertEquals("Hello World", request.text)
    assertEquals("input_field", request.resourceId)
  }

  @Test
  fun `deserialize pre-dispatch state read and optional insert baseline`() {
    val capture =
      json.decodeFromString<WebSocketRequest>(
        """{"type":"request_insert_text_state","requestId":"before"}""",
      )
    assertIs<RequestInsertTextState>(capture)
    assertEquals("before", capture.requestId)
    val insert =
      json.decodeFromString<WebSocketRequest>(
        """{"type":"request_insert_text","text":"😀","precedingState":{"text":"éx","selectionStart":2,"selectionEnd":2}}""",
      )
    assertIs<RequestInsertText>(insert)
    assertEquals(InsertTextState("éx", false, 2, 2), insert.precedingState)
    val legacy =
      json.decodeFromString<WebSocketRequest>("""{"type":"request_insert_text","text":"😀"}""")
    assertIs<RequestInsertText>(legacy)
    assertEquals(null, legacy.precedingState)
    assertFalse(
      json.encodeToString(WebSocketRequest.serializer(), legacy).contains("precedingState"),
    )
  }

  @Test
  fun `deserialize request_insert_text with expectedSuffix`() {
    val request =
      json.decodeFromString<WebSocketRequest>(
        """{"type":"request_insert_text","requestId":"id","text":"t","expectedSuffix":"ab"}""",
      )
    assertIs<RequestInsertText>(request)
    assertEquals("ab", request.expectedSuffix)
  }

  @Test
  fun `deserialize request_insert_text capability opt in`() {
    val request =
      json.decodeFromString<WebSocketRequest>(
        """{"type":"request_insert_text","text":"t","acceptsCaretNotPlaced":true}""",
      ) as RequestInsertText
    assertTrue(request.acceptsCaretNotPlaced)
  }

  @Test
  fun `deserialize request_insert_text`() {
    val message = """{"type":"request_insert_text","requestId":"insert-1","text":"Hello World"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestInsertText>(request)
    assertEquals(null, request.expectedSuffix)
    assertFalse(request.acceptsCaretNotPlaced)
    assertEquals("insert-1", request.requestId)
    assertEquals("Hello World", request.text)
  }

  @Test
  fun `deserialize request_ime_action`() {
    val message = """{"type":"request_ime_action","requestId":"ime-1","action":"search"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestImeAction>(request)
    assertEquals("ime-1", request.requestId)
    assertEquals("search", request.action)
  }
}
