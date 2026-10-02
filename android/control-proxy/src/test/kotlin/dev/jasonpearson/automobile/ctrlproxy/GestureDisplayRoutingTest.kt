package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.DragResult
import dev.jasonpearson.automobile.protocol.PinchResult
import dev.jasonpearson.automobile.protocol.RequestDrag
import dev.jasonpearson.automobile.protocol.RequestGestureStart
import dev.jasonpearson.automobile.protocol.RequestPinch
import dev.jasonpearson.automobile.protocol.RequestSwipe
import dev.jasonpearson.automobile.protocol.RequestTapCoordinates
import dev.jasonpearson.automobile.protocol.RequestTwoFingerSwipe
import dev.jasonpearson.automobile.protocol.SwipeResult
import dev.jasonpearson.automobile.protocol.TapCoordinatesResult
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class GestureDisplayRoutingTest {
  private class FakeBuilder : GestureDisplayIdApplier {
    val displays = mutableListOf<Int>()

    override fun setDisplayId(displayId: Int) {
      displays.add(displayId)
    }
  }

  @Test
  fun `builder applies only explicit supported display ids`() {
    for (sdk in listOf(29, 30, 36)) {
      for (displayId in listOf(null, 0, 7)) {
        val builder = FakeBuilder()
        if (sdk < 30 && displayId == 7) {
          assertThrows(IllegalArgumentException::class.java) {
            GestureDisplayRouting.apply(displayId, sdk, builder)
          }
        } else {
          GestureDisplayRouting.apply(displayId, sdk, builder)
        }
        assertEquals(
          if (sdk >= 30 && displayId != null) listOf(displayId) else emptyList<Int>(),
          builder.displays,
        )
      }
    }
    val builder = FakeBuilder()
    assertThrows(IllegalArgumentException::class.java) {
      GestureDisplayRouting.apply(-1, 30, builder)
    }
    assertTrue(builder.displays.isEmpty())
  }

  @Test
  fun `tap swipe pinch and stream start return typed failures before dispatch`() = runTest {
    for ((sdk, displayId) in listOf(29 to 7, 29 to -1, 30 to -1)) {
      val actions = RecordingCtrlProxyActions()
      val handler = CtrlProxyMessageHandler(actions, sdkInt = { sdk })
      val requests =
        listOf(
          RequestTapCoordinates("tap", 1.0, 2.0, displayId = displayId),
          RequestSwipe("swipe", 1.0, 2.0, 3.0, 4.0, displayId = displayId),
          RequestTwoFingerSwipe("two", 1.0, 2.0, 3.0, 4.0, displayId = displayId),
          RequestDrag("drag", 1.0, 2.0, 3.0, 4.0, displayId = displayId),
          RequestPinch("pinch", 1.0, 2.0, 3.0, 4.0, displayId = displayId),
          RequestGestureStart("start", "g", 1.0, 2.0, displayId = displayId),
        )
      for (request in requests) {
        val result = handler.handleMessage(request)
        val error =
          when (result) {
            is TapCoordinatesResult -> {
              assertFalse(result.success)
              result.error
            }
            is SwipeResult -> {
              assertFalse(result.success)
              result.error
            }
            is DragResult -> {
              assertFalse(result.success)
              result.error
            }
            is PinchResult -> {
              assertFalse(result.success)
              result.error
            }
            else -> error("Expected typed gesture failure")
          }
        val responseId =
          when (result) {
            is TapCoordinatesResult -> result.requestId
            is SwipeResult -> result.requestId
            is DragResult -> result.requestId
            is PinchResult -> result.requestId
            else -> error("Expected typed gesture failure")
          }
        assertEquals(request.requestId, responseId)
        assertEquals(GestureDisplayRouting.error(displayId, sdk), error)
      }
      assertTrue(actions.calls.isEmpty())
    }
  }

  @Test
  fun `handler forwards display for tap swipe pinch and stream start`() = runTest {
    for (sdk in listOf(29, 30)) {
      for (displayId in if (sdk < 30) listOf(null, 0) else listOf(null, 0, 7)) {
        val builder = FakeBuilder()
        val recording = RecordingCtrlProxyActions()
        val received = mutableListOf<Int?>()
        val actions =
          object : CtrlProxyActions by recording {
            private fun apply(displayId: Int?) {
              received.add(displayId)
              GestureDisplayRouting.apply(displayId, sdk, builder)
            }

            override fun requestTapCoordinates(
              requestId: String?,
              x: Double,
              y: Double,
              duration: Long,
              frameContext: String?,
              displayId: Int?,
            ) = apply(displayId)

            override fun requestSwipe(
              requestId: String?,
              x1: Double,
              y1: Double,
              x2: Double,
              y2: Double,
              duration: Long,
              frameContext: String?,
              displayId: Int?,
            ) = apply(displayId)

            override fun requestPinch(
              requestId: String?,
              centerX: Double,
              centerY: Double,
              distanceStart: Double,
              distanceEnd: Double,
              rotationDegrees: Float,
              duration: Long,
              displayId: Int?,
            ) = apply(displayId)

            override fun requestGestureStart(
              requestId: String?,
              gestureId: String,
              x: Double,
              y: Double,
              displayId: Int?,
            ) = apply(displayId)
          }
        val handler = CtrlProxyMessageHandler(actions, sdkInt = { sdk })
        val requests =
          listOf(
            RequestTapCoordinates("tap", 1.0, 2.0, displayId = displayId),
            RequestSwipe("swipe", 1.0, 2.0, 3.0, 4.0, displayId = displayId),
            RequestPinch("pinch", 1.0, 2.0, 3.0, 4.0, displayId = displayId),
            RequestGestureStart("start", "g", 1.0, 2.0, displayId = displayId),
          )
        for (request in requests) assertNull(handler.handleMessage(request))
        assertEquals(List(4) { displayId }, received)
        assertEquals(
          if (sdk >= 30 && displayId != null) List(4) { displayId } else emptyList<Int>(),
          builder.displays,
        )
      }
    }
  }
}
