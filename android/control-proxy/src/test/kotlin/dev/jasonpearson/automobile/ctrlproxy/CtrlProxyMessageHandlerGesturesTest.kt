package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.RequestDrag
import dev.jasonpearson.automobile.protocol.RequestGestureStart
import dev.jasonpearson.automobile.protocol.RequestPinch
import dev.jasonpearson.automobile.protocol.RequestSwipe
import dev.jasonpearson.automobile.protocol.RequestTapCoordinates
import dev.jasonpearson.automobile.protocol.RequestTwoFingerSwipe
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

internal class CtrlProxyMessageHandlerGesturesTest : CtrlProxyMessageHandlerFixtures() {
  // ---------------------------------------------------------------------------
  // Gestures
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches request_swipe`() = runTest {
    dispatch(
      """{"type":"request_swipe","requestId":"sw1","x1":0,"y1":100,"x2":0,"y2":500,"duration":400}""",
    )
    // Coordinates dispatch as Double (#2927); integer JSON decodes to identical .0 values.
    assertEquals(
      "requestSwipe" to
        listOf<Any?>(
          RequestSwipe(
            requestId = "sw1",
            x1 = 0.0,
            y1 = 100.0,
            x2 = 0.0,
            y2 = 500.0,
            duration = 400L,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `swipe dispatch preserves frame and display in the typed request`() = runTest {
    for (frame in listOf("null", "\"frame-swipe\"")) {
      for (displayId in listOf(null, 0, 2)) {
        assertTypedDispatch(
          """{"type":"request_swipe","requestId":"swipe","x1":1.25,"y1":2.5,"x2":3.75,"y2":4.125,"duration":417,"frameContext":$frame,"displayId":$displayId}""",
          "requestSwipe" to
            listOf<Any?>(
              RequestSwipe(
                requestId = "swipe",
                x1 = 1.25,
                y1 = 2.5,
                x2 = 3.75,
                y2 = 4.125,
                duration = 417L,
                frameContext = if (frame == "null") null else "frame-swipe",
                displayId = displayId,
              ),
            ),
        )
      }
    }
  }

  @Test
  fun `dispatches request_tap_coordinates with default duration`() = runTest {
    dispatch("""{"type":"request_tap_coordinates","requestId":"t1","x":100,"y":200}""")
    assertEquals(
      "requestTapCoordinates" to
        listOf<Any?>(RequestTapCoordinates(requestId = "t1", x = 100.0, y = 200.0, duration = 10L)),
      lastCall,
    )
  }

  @Test
  fun `dispatches atomic double tap with frame and display routing`() = runTest {
    val request =
      json.decodeFromString<WebSocketRequest>(
        """{"type":"request_tap_coordinates","requestId":"d1","x":100,"y":200,"doubleTap":true,"frameContext":"frame","displayId":2}""",
      )
    CtrlProxyMessageHandler(actions, sdkInt = { 30 }).handleMessage(request)
    assertEquals(
      "requestDoubleTapCoordinates" to listOf<Any?>("d1", 100.0, 200.0, "frame", 2),
      lastCall,
    )
  }

  @Test
  fun `tap dispatch selects single or double tap preserving frame and display`() = runTest {
    for (frame in listOf("null", "\"frame-tap\"")) {
      for (displayId in listOf(null, 0, 2)) {
        for (doubleTap in listOf(false, true)) {
          val context = if (frame == "null") null else "frame-tap"
          val expected =
            if (doubleTap)
              "requestDoubleTapCoordinates" to listOf<Any?>("tap", 1.25, 2.5, context, displayId)
            else
              "requestTapCoordinates" to
                listOf<Any?>(
                  RequestTapCoordinates(
                    requestId = "tap",
                    x = 1.25,
                    y = 2.5,
                    duration = 73L,
                    frameContext = context,
                    displayId = displayId,
                  ),
                )
          assertTypedDispatch(
            """{"type":"request_tap_coordinates","requestId":"tap","x":1.25,"y":2.5,"duration":73,"frameContext":$frame,"displayId":$displayId,"doubleTap":$doubleTap}""",
            expected,
          )
        }
      }
    }
  }

  @Test
  fun `dispatches request_two_finger_swipe`() = runTest {
    dispatch(
      """{"type":"request_two_finger_swipe","requestId":"tf1","x1":0,"y1":0,"x2":10,"y2":20,"duration":300,"offset":50}""",
    )
    // offset stays Int (pixel offset, not a coordinate).
    assertEquals(
      "requestTwoFingerSwipe" to
        listOf<Any?>(
          RequestTwoFingerSwipe(
            requestId = "tf1",
            x1 = 0.0,
            y1 = 0.0,
            x2 = 10.0,
            y2 = 20.0,
            duration = 300L,
            offset = 50,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `two finger swipe dispatch preserves offset and nullable display`() = runTest {
    for (displayId in listOf(null, 0, 2)) {
      assertTypedDispatch(
        """{"type":"request_two_finger_swipe","requestId":"two","x1":1.25,"y1":2.5,"x2":3.75,"y2":4.125,"duration":417,"offset":23,"displayId":$displayId}""",
        "requestTwoFingerSwipe" to
          listOf<Any?>(
            RequestTwoFingerSwipe(
              requestId = "two",
              x1 = 1.25,
              y1 = 2.5,
              x2 = 3.75,
              y2 = 4.125,
              duration = 417L,
              offset = 23,
              displayId = displayId,
            ),
          ),
      )
    }
  }

  @Test
  fun `dispatches request_drag resolving legacy holdTime and duration`() = runTest {
    dispatch(
      """{"type":"request_drag","requestId":"d1","x1":50,"y1":50,"x2":150,"y2":150,"holdTime":800,"duration":500}""",
    )
    // holdTime resolves press duration, duration resolves drag duration, hold defaults to 100.
    assertEquals(
      "requestDrag" to
        listOf<Any?>(
          RequestDrag(
            requestId = "d1",
            x1 = 50.0,
            y1 = 50.0,
            x2 = 150.0,
            y2 = 150.0,
            holdTime = 800L,
            duration = 500L,
            holdDurationMs = 100L,
          ),
        ),
      lastCall,
    )
    val request = lastCall.second.single() as RequestDrag
    assertEquals(800L, request.resolvedPressDurationMs)
    assertEquals(500L, request.resolvedDragDurationMs)
  }

  @Test
  fun `drag dispatch resolves each legacy duration independently and preserves routing`() =
    runTest {
      val durations =
        listOf(
          Triple("", 600L, 300L),
          Triple(",\"holdTime\":810,\"duration\":510", 810L, 510L),
          Triple(
            ",\"pressDurationMs\":600,\"dragDurationMs\":300,\"holdTime\":810,\"duration\":510",
            810L,
            510L,
          ),
          Triple(
            ",\"pressDurationMs\":71,\"dragDurationMs\":83,\"holdTime\":810,\"duration\":510",
            71L,
            83L,
          ),
          Triple(",\"pressDurationMs\":71,\"holdTime\":810,\"duration\":510", 71L, 510L),
          Triple(",\"dragDurationMs\":83,\"holdTime\":810,\"duration\":510", 810L, 83L),
        )
      for ((fields, press, drag) in durations) {
        for (frame in listOf("null", "\"frame-drag\"")) {
          for (displayId in listOf(null, 2)) {
            assertResolvedDragDispatch(
              """{"type":"request_drag","requestId":"drag","x1":1.25,"y1":2.5,"x2":3.75,"y2":4.125,"holdDurationMs":19,"frameContext":$frame,"displayId":$displayId$fields}""",
              "requestDrag" to
                listOf<Any?>(
                  RequestDrag(
                    requestId = "drag",
                    x1 = 1.25,
                    y1 = 2.5,
                    x2 = 3.75,
                    y2 = 4.125,
                    pressDurationMs = press,
                    dragDurationMs = drag,
                    holdDurationMs = 19L,
                    frameContext = if (frame == "null") null else "frame-drag",
                    displayId = displayId,
                  ),
                ),
            )
          }
        }
      }
    }

  @Test
  fun `dispatches request_pinch`() = runTest {
    dispatch(
      """{"type":"request_pinch","requestId":"pi1","centerX":540,"centerY":960,"distanceStart":100,"distanceEnd":300,"rotationDegrees":45.0,"duration":500}""",
    )
    assertEquals(
      "requestPinch" to
        listOf<Any?>(
          RequestPinch(
            requestId = "pi1",
            centerX = 540.0,
            centerY = 960.0,
            distanceStart = 100.0,
            distanceEnd = 300.0,
            rotationDegrees = 45.0f,
            duration = 500L,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_pinch preserving fractional coordinates`() = runTest {
    // #2927: a fractional center/distance survives decode and reaches the action as Double,
    // not truncated to Int.
    dispatch(
      """{"type":"request_pinch","requestId":"pi-frac","centerX":100.5,"centerY":200.25,"distanceStart":80.5,"distanceEnd":120.75,"rotationDegrees":45.0,"duration":500}""",
    )
    assertEquals(
      "requestPinch" to
        listOf<Any?>(
          RequestPinch(
            requestId = "pi-frac",
            centerX = 100.5,
            centerY = 200.25,
            distanceStart = 80.5,
            distanceEnd = 120.75,
            rotationDegrees = 45.0f,
            duration = 500L,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_swipe preserving fractional coordinates`() = runTest {
    dispatch(
      """{"type":"request_swipe","requestId":"sw-frac","x1":0.5,"y1":100.25,"x2":10.75,"y2":500.125,"duration":400}""",
    )
    assertEquals(
      "requestSwipe" to
        listOf<Any?>(
          RequestSwipe(
            requestId = "sw-frac",
            x1 = 0.5,
            y1 = 100.25,
            x2 = 10.75,
            y2 = 500.125,
            duration = 400L,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `pinch dispatch preserves rotation duration and nullable display`() = runTest {
    for (displayId in listOf(null, 0, 2)) {
      assertTypedDispatch(
        """{"type":"request_pinch","requestId":"pinch","centerX":1.25,"centerY":2.5,"distanceStart":3.75,"distanceEnd":4.125,"rotationDegrees":27.5,"duration":417,"displayId":$displayId}""",
        "requestPinch" to
          listOf<Any?>(
            RequestPinch(
              requestId = "pinch",
              centerX = 1.25,
              centerY = 2.5,
              distanceStart = 3.75,
              distanceEnd = 4.125,
              rotationDegrees = 27.5f,
              duration = 417L,
              displayId = displayId,
            ),
          ),
      )
    }
  }

  @Test
  fun `gesture start dispatch preserves stream id coordinates and nullable display`() = runTest {
    for (displayId in listOf(null, 0, 2)) {
      assertTypedDispatch(
        """{"type":"request_gesture_start","requestId":"start","gestureId":"stream","x":1.25,"y":2.5,"displayId":$displayId}""",
        "requestGestureStart" to
          listOf<Any?>(
            RequestGestureStart(
              requestId = "start",
              gestureId = "stream",
              x = 1.25,
              y = 2.5,
              displayId = displayId,
            ),
          ),
      )
    }
  }
}
