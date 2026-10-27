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
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.SerializationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

internal class CtrlProxyMessageHandlerGestureGuardTest : CtrlProxyMessageHandlerFixtures() {
  // ---------------------------------------------------------------------------
  // Non-finite gesture-coordinate guard (#2964 — mirror of iOS #2928 / PR #2957)
  //
  // WIRE REALITY (empirically verified, correcting the #2964 premise): kotlinx.serialization's
  // default config (`allowSpecialFloatingPointValues = false`, used by
  // WebSocketServer.protocolJson)
  // REJECTS a JSON overflow literal like `1e309` at decode with a JsonDecodingException
  // ("Unexpected special floating-point value Infinity") — it does NOT coerce it to
  // Double.POSITIVE_INFINITY into the widened field. This is the same posture as Apple's
  // JSONDecoder
  // on iOS (#2928), so a non-finite coordinate cannot arrive over the wire on either runner, and
  // standard JSON has no NaN/Infinity literal for the TS client to send anyway.
  //
  // The `isFinite` guard is therefore defense-in-depth for the NON-WIRE construction path — an
  // in-process caller building a request data class from a computed Double (division, hypot,
  // normalized offset) that yields NaN/±Infinity — exactly as iOS framed its guard. These tests
  // drive that reachable path by constructing the sealed requests directly, plus one test pinning
  // the wire decode-rejection behavior so a future kotlinx/config change that flips it is caught.
  // ---------------------------------------------------------------------------

  /** Assert a guarded error response was returned, no gesture dispatched, and it names [field]. */
  private fun assertGuarded(response: WebSocketResponse?, field: String) {
    assertTrue(
      "expected a non-null guard response, got null (request was dispatched)",
      response != null,
    )
    assertTrue("guard must not dispatch to the gesture engine", calls.isEmpty())
    val (success, error) =
      when (response) {
        is TapCoordinatesResult -> response.success to response.error
        is SwipeResult -> response.success to response.error
        is DragResult -> response.success to response.error
        is PinchResult -> response.success to response.error
        else -> throw AssertionError("unexpected guard response type: $response")
      }
    assertFalse("guard response must have success=false", success)
    assertTrue("error must be actionable", !error.isNullOrBlank())
    assertTrue("error must name the offending field ($field): $error", error!!.contains(field))
    assertTrue(
      "error must mention finiteness: $error",
      error.contains("finite", ignoreCase = true),
    )
  }

  // --- Non-wire construction path: the reachable path the guard actually protects. ---

  @Test
  fun `rejects tap with NaN coordinate`() = runTest {
    val response =
      handler.handleMessage(RequestTapCoordinates(requestId = "t", x = Double.NaN, y = 200.0))
    assertGuarded(response, "x")
    assertTrue(response is TapCoordinatesResult)
    assertEquals("t", (response as TapCoordinatesResult).requestId)
  }

  @Test
  fun `gesture start rejects each non finite coordinate without dispatch`() = runTest {
    for ((field, x, y) in
      listOf(Triple("x", Double.NaN, 2.0), Triple("y", 1.0, Double.POSITIVE_INFINITY))) {
      val response = handler.handleMessage(RequestGestureStart("start-guard", "stream", x, y))
      assertGuarded(response, field)
      assertTrue(response is SwipeResult)
      assertEquals("start-guard", (response as SwipeResult).requestId)
    }
  }

  @Test
  fun `double tap rejects each non finite coordinate without dispatch`() = runTest {
    for ((field, x, y) in
      listOf(Triple("x", Double.NaN, 2.0), Triple("y", 1.0, Double.POSITIVE_INFINITY))) {
      val response =
        handler.handleMessage(RequestTapCoordinates("double-guard", x, y, doubleTap = true))
      assertGuarded(response, field)
      assertTrue(response is TapCoordinatesResult)
      assertEquals("double-guard", (response as TapCoordinatesResult).requestId)
    }
  }

  @Test
  fun `rejects swipe with positive-infinity coordinate`() = runTest {
    val response =
      handler.handleMessage(
        RequestSwipe(
          requestId = "s",
          x1 = 0.0,
          y1 = 0.0,
          x2 = Double.POSITIVE_INFINITY,
          y2 = 500.0,
        ),
      )
    assertGuarded(response, "x2")
    assertTrue(response is SwipeResult)
    assertEquals("s", (response as SwipeResult).requestId)
  }

  @Test
  fun `rejects two-finger swipe with negative-infinity coordinate`() = runTest {
    // Two-finger swipe shares the swipe_result response type.
    val response =
      handler.handleMessage(
        RequestTwoFingerSwipe(
          requestId = "tf",
          x1 = 0.0,
          y1 = Double.NEGATIVE_INFINITY,
          x2 = 10.0,
          y2 = 20.0,
        ),
      )
    assertGuarded(response, "y1")
    assertTrue(response is SwipeResult)
    assertEquals("tf", (response as SwipeResult).requestId)
  }

  @Test
  fun `rejects two-finger swipe with an unsupported fingerCount before dispatch`() = runTest {
    for (count in listOf(0, 1, 6)) {
      val response =
        handler.handleMessage(
          RequestTwoFingerSwipe(
            requestId = "mf",
            x1 = 0.0,
            y1 = 0.0,
            x2 = 10.0,
            y2 = 20.0,
            fingerCount = count,
          ),
        )
      assertTrue(response is SwipeResult)
      assertEquals(false, (response as SwipeResult).success)
      assertTrue(response.error!!.contains("fingerCount must be 2-5"))
    }
  }

  @Test
  fun `rejects drag with NaN coordinate`() = runTest {
    val response =
      handler.handleMessage(
        RequestDrag(requestId = "d", x1 = 50.0, y1 = 50.0, x2 = 150.0, y2 = Double.NaN),
      )
    assertGuarded(response, "y2")
    assertTrue(response is DragResult)
    assertEquals("d", (response as DragResult).requestId)
  }

  @Test
  fun `rejects pinch with positive-infinity coordinate`() = runTest {
    val response =
      handler.handleMessage(
        RequestPinch(
          requestId = "p",
          centerX = Double.POSITIVE_INFINITY,
          centerY = 960.0,
          distanceStart = 100.0,
          distanceEnd = 300.0,
        ),
      )
    assertGuarded(response, "centerX")
    assertTrue(response is PinchResult)
    assertEquals("p", (response as PinchResult).requestId)
  }

  // AC #4: rotationDegrees is a non-coordinate Float that flows to the gesture-path math; a
  // computed
  // non-finite value must be rejected too (Android-specific — iOS decode-rejects the wire literal).
  @Test
  fun `rejects pinch with non-finite rotationDegrees`() = runTest {
    val response =
      handler.handleMessage(
        RequestPinch(
          requestId = "p",
          centerX = 540.0,
          centerY = 960.0,
          distanceStart = 100.0,
          distanceEnd = 300.0,
          rotationDegrees = Float.POSITIVE_INFINITY,
        ),
      )
    assertGuarded(response, "rotationDegrees")
    assertTrue(response is PinchResult)
    assertEquals("p", (response as PinchResult).requestId)
  }

  // Parametrized: pin EVERY coordinate field across every family — each field, individually forced
  // non-finite via direct construction, must be rejected and must name that field.
  @Test
  fun `rejects every coordinate field of every gesture family`() = runTest {
    val inf = Double.POSITIVE_INFINITY
    val cases: List<Pair<String, WebSocketRequest>> =
      listOf(
        "x" to RequestTapCoordinates(x = inf, y = 200.0),
        "y" to RequestTapCoordinates(x = 100.0, y = inf),
        "x1" to RequestSwipe(x1 = inf, y1 = 0.0, x2 = 10.0, y2 = 20.0),
        "y1" to RequestSwipe(x1 = 0.0, y1 = inf, x2 = 10.0, y2 = 20.0),
        "x2" to RequestSwipe(x1 = 0.0, y1 = 0.0, x2 = inf, y2 = 20.0),
        "y2" to RequestSwipe(x1 = 0.0, y1 = 0.0, x2 = 10.0, y2 = inf),
        "x1" to RequestTwoFingerSwipe(x1 = inf, y1 = 0.0, x2 = 10.0, y2 = 20.0),
        "y1" to RequestTwoFingerSwipe(x1 = 0.0, y1 = inf, x2 = 10.0, y2 = 20.0),
        "x2" to RequestTwoFingerSwipe(x1 = 0.0, y1 = 0.0, x2 = inf, y2 = 20.0),
        "y2" to RequestTwoFingerSwipe(x1 = 0.0, y1 = 0.0, x2 = 10.0, y2 = inf),
        "x1" to RequestDrag(x1 = inf, y1 = 0.0, x2 = 10.0, y2 = 20.0),
        "y1" to RequestDrag(x1 = 0.0, y1 = inf, x2 = 10.0, y2 = 20.0),
        "x2" to RequestDrag(x1 = 0.0, y1 = 0.0, x2 = inf, y2 = 20.0),
        "y2" to RequestDrag(x1 = 0.0, y1 = 0.0, x2 = 10.0, y2 = inf),
        "centerX" to
          RequestPinch(centerX = inf, centerY = 960.0, distanceStart = 100.0, distanceEnd = 300.0),
        "centerY" to
          RequestPinch(centerX = 540.0, centerY = inf, distanceStart = 100.0, distanceEnd = 300.0),
        "distanceStart" to
          RequestPinch(centerX = 540.0, centerY = 960.0, distanceStart = inf, distanceEnd = 300.0),
        "distanceEnd" to
          RequestPinch(centerX = 540.0, centerY = 960.0, distanceStart = 100.0, distanceEnd = inf),
      )
    for ((field, request) in cases) {
      actions.calls.clear()
      val response = handler.handleMessage(request)
      assertGuarded(response, field)
    }
  }

  // --- Wire reality: the `1e309` overflow literal is rejected at DECODE, not coerced to Infinity.
  // This is the truthful analog of iOS PR #2957's testOverflowCoordinateLiteralIsRejectedAtDecode,
  // and correcting the #2964 premise that kotlinx would coerce it into the widened field. A future
  // kotlinx/config change that flips this to coercion trips this test and re-arms the guard's role.
  @Test
  fun `overflow coordinate literal is rejected at decode not coerced to infinity`() {
    // The class-level [json] matches production's protocolJson posture
    // (allowSpecialFloatingPointValues defaults to false), so this is the production decode path.
    // SerializationException is the stable supertype of the (experimental) JsonDecodingException
    // kotlinx throws here; the message assertion below pins the exact special-float rejection.
    val ex =
      assertThrows(SerializationException::class.java) {
        json.decodeFromString<WebSocketRequest>(
          """{"type":"request_tap_coordinates","requestId":"t","x":1e309,"y":200}""",
        )
      }
    assertTrue(
      "decode must reject the overflow literal as a special float: ${ex.message}",
      ex.message.orEmpty().contains("special floating-point", ignoreCase = true),
    )
  }

  // AC #3: the #2927 happy path (finite fractional + negative coordinates) is unaffected — the
  // guard returns null and the gesture dispatches exactly as before.
  @Test
  fun `finite fractional and negative coordinates still dispatch`() = runTest {
    val response =
      dispatchForResponse(
        """{"type":"request_swipe","requestId":"ok","x1":-0.5,"y1":100.25,"x2":10.75,"y2":500.125,"duration":400}""",
      )
    assertNull("finite coordinates must not be guarded", response)
    assertEquals(
      "requestSwipe" to
        listOf<Any?>(
          RequestSwipe(
            requestId = "ok",
            x1 = -0.5,
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
  fun `finite pinch with rotationDegrees still dispatches`() = runTest {
    val response =
      dispatchForResponse(
        """{"type":"request_pinch","requestId":"okp","centerX":540,"centerY":960,"distanceStart":100,"distanceEnd":300,"rotationDegrees":45.0,"duration":500}""",
      )
    assertNull(response)
    assertEquals(
      "requestPinch" to
        listOf<Any?>(
          RequestPinch(
            requestId = "okp",
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

  // A huge but finite two-finger `offset` (Int, cannot be non-finite) is unaffected by the guard.
  @Test
  fun `large finite two-finger offset still dispatches`() = runTest {
    val response =
      dispatchForResponse(
        """{"type":"request_two_finger_swipe","requestId":"tfo","x1":0,"y1":0,"x2":10,"y2":20,"duration":300,"offset":100000}""",
      )
    assertNull(response)
    assertEquals(
      "requestTwoFingerSwipe" to
        listOf<Any?>(
          RequestTwoFingerSwipe(
            requestId = "tfo",
            x1 = 0.0,
            y1 = 0.0,
            x2 = 10.0,
            y2 = 20.0,
            duration = 300L,
            offset = 100000,
          ),
        ),
      lastCall,
    )
  }
}
