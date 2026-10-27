package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class ErrorFrameJsonTest {
  @Test
  fun `error values round trip through JSON result frames`() {
    val error = "bad \"quote\" and \\backslash\\ and\nline and emoji 😀"
    val json = Json
    val frames =
      listOf(
        "swipe_result" to
          swipeResultFrame(
            GestureFrameResult(
              requestId = "request",
              success = false,
              error = error,
              totalTimeMs = 10L,
              gestureTimeMs = 5L,
            ),
            null,
          ),
        "drag_result" to
          dragResultFrame(
            GestureFrameResult(
              requestId = "request",
              success = false,
              error = error,
              totalTimeMs = 10L,
              gestureTimeMs = 5L,
            ),
            null,
          ),
        "tap_coordinates_result" to tapCoordinatesResultFrame("request", false, error, 10L, null),
        "pinch_result" to
          pinchResultFrame(
            GestureFrameResult(
              requestId = "request",
              success = false,
              error = error,
              totalTimeMs = 10L,
              gestureTimeMs = 5L,
            ),
            null,
          ),
        "screenshot_error" to screenshotErrorFrame("request", error),
        "current_focus_result" to currentFocusErrorFrame("request", error, 10L),
        "traversal_order_result" to traversalOrderErrorFrame("request", error, 10L),
      )

    frames.forEach { (type, frame) ->
      val parsed = json.parseToJsonElement(frame).jsonObject
      assertEquals(
        type,
        parsed["type"]!!.jsonPrimitive.content,
      )
      assertEquals(error, parsed["error"]!!.jsonPrimitive.content)
    }
  }
}
