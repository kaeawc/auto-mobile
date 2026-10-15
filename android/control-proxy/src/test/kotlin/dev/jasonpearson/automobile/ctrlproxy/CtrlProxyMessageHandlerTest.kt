package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.ctrlproxy.prototype.FakePrototypeHost
import dev.jasonpearson.automobile.ctrlproxy.prototype.FakePrototypeTimer
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeController
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeLifecycle
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeResultSink
import dev.jasonpearson.automobile.protocol.DragResult
import dev.jasonpearson.automobile.protocol.ImeTextDelivery
import dev.jasonpearson.automobile.protocol.NetworkMockRuleDto
import dev.jasonpearson.automobile.protocol.PinchResult
import dev.jasonpearson.automobile.protocol.PrototypeResult
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeTextNode
import dev.jasonpearson.automobile.protocol.RequestCommitText
import dev.jasonpearson.automobile.protocol.RequestDrag
import dev.jasonpearson.automobile.protocol.RequestGestureStart
import dev.jasonpearson.automobile.protocol.RequestGlobalAction
import dev.jasonpearson.automobile.protocol.RequestHierarchy
import dev.jasonpearson.automobile.protocol.RequestImeAction
import dev.jasonpearson.automobile.protocol.RequestInsertText
import dev.jasonpearson.automobile.protocol.RequestPinch
import dev.jasonpearson.automobile.protocol.RequestScreenshot
import dev.jasonpearson.automobile.protocol.RequestSetText
import dev.jasonpearson.automobile.protocol.RequestSwipe
import dev.jasonpearson.automobile.protocol.RequestTapCoordinates
import dev.jasonpearson.automobile.protocol.RequestTwoFingerSwipe
import dev.jasonpearson.automobile.protocol.SwipeResult
import dev.jasonpearson.automobile.protocol.TapCoordinatesResult
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.websocket.CloseReason
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers

/**
 * Verifies that [CtrlProxyMessageHandler] decodes each wire message into the correct sealed
 * [WebSocketRequest] and dispatches it to the matching [CtrlProxyActions] method with the expected
 * arguments. This is the entire inbound command surface of the on-device runner, so every request
 * type the TS client can send has a case here.
 *
 * The handler and [RecordingCtrlProxyActions] fake are Android-free, so these are fast pure-JVM
 * tests — no Robolectric.
 */
class CtrlProxyMessageHandlerTest {
  companion object {
    @BeforeClass
    @JvmStatic
    fun initializeDispatchClasses() = runTest {
      // Initialize coroutines and generated serializers once, outside per-test timings.
      // Each test still gets its own recording fake and handler.
      CtrlProxyMessageHandlerTest()
        .dispatch("""{"type":"request_select_all","requestId":"warmup"}""")
    }
  }

  private val json = Json {
    classDiscriminator = "type"
    ignoreUnknownKeys = true
  }

  private val actions = RecordingCtrlProxyActions()
  private val logs = mutableListOf<String>()
  private val handler = CtrlProxyMessageHandler(actions, log = { logs.add(it) })

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun `handler awaits action completion before returning`() = runTest {
    val release = CompletableDeferred<Unit>()
    val events = mutableListOf<String>()
    val handler =
      CtrlProxyMessageHandler(
        object : NoOpCtrlProxyActions() {
          override suspend fun requestHierarchy(request: RequestHierarchy) {
            events += "action started"
            release.await()
            events += "action completed"
          }
        },
      )
    val dispatch = launch {
      assertNull(handler.handleMessage(RequestHierarchy(requestId = "held")))
      events += "handler returned"
    }
    runCurrent()
    assertEquals(listOf("action started"), events)
    assertFalse(dispatch.isCompleted)
    release.complete(Unit)
    runCurrent()
    assertEquals(listOf("action started", "action completed", "handler returned"), events)
    assertTrue(dispatch.isCompleted)
  }

  private val calls: List<Pair<String, List<Any?>>>
    get() = actions.calls

  private val lastCall: Pair<String, List<Any?>>
    get() = actions.calls.last()

  private suspend fun dispatch(message: String) {
    handler.handleMessage(json.decodeFromString<WebSocketRequest>(message))
  }

  private suspend fun assertTypedDispatch(
    message: String,
    expected: Pair<String, List<Any?>>,
  ) {
    val recording = RecordingCtrlProxyActions()
    val decoded = json.decodeFromString<WebSocketRequest>(message)
    val result = CtrlProxyMessageHandler(recording, sdkInt = { 30 }).handleMessage(decoded)
    assertNull(result)
    assertEquals(1, recording.calls.size)
    // Double tap intentionally retains its separate positional method.
    if (decoded !is RequestTapCoordinates || !decoded.doubleTap) {
      assertSame(decoded, recording.calls.single().second.single())
    }
    assertEquals(listOf(expected), recording.calls)
  }

  private suspend fun assertResolvedDragDispatch(
    message: String,
    expected: Pair<String, List<Any?>>,
  ) {
    val recording = RecordingCtrlProxyActions()
    val decoded = json.decodeFromString<WebSocketRequest>(message) as RequestDrag
    val result = CtrlProxyMessageHandler(recording, sdkInt = { 30 }).handleMessage(decoded)
    assertNull(result)
    assertEquals(1, recording.calls.size)
    val recorded = recording.calls.single().second.single() as RequestDrag
    assertSame(decoded, recorded)
    // Resolution now happens in CtrlProxy. Retain the pinned effective-duration assertions while
    // also proving the handler forwards the original request with both legacy fields intact.
    assertEquals(
      expected,
      recording.calls.single().first to
        listOf<Any?>(
          recorded.copy(
            pressDurationMs = recorded.resolvedPressDurationMs,
            dragDurationMs = recorded.resolvedDragDurationMs,
            holdTime = null,
            duration = null,
          ),
        ),
    )
  }

  /** Dispatch and return the synchronous response (non-null only for the guard/error paths). */
  private suspend fun dispatchForResponse(message: String): WebSocketResponse? =
    handler.handleMessage(json.decodeFromString<WebSocketRequest>(message))

  // ---------------------------------------------------------------------------
  // Hierarchy / screenshot
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches IME trace opt in and delegates the typed request`() = runTest {
    val traceFlags = mutableListOf<Boolean>()
    val tracedActions =
      object : CtrlProxyActions by actions {
        override suspend fun requestCommitText(request: RequestCommitText) {
          traceFlags.add(request.trace)
          actions.requestCommitText(request)
        }
      }
    val tracedHandler = CtrlProxyMessageHandler(tracedActions)
    for (suffix in listOf("", ",\"trace\":true")) {
      tracedHandler.handleMessage(
        json.decodeFromString<WebSocketRequest>(
          """{"type":"request_commit_text","text":"value"$suffix}""",
        ),
      )
    }
    assertEquals(listOf(false, true), traceFlags)
    assertEquals(
      "requestCommitText" to
        listOf<Any?>(
          RequestCommitText(
            requestId = null,
            text = "value",
            priorImeId = null,
            delivery = ImeTextDelivery.COMMIT,
            timeoutMs = null,
            trace = true,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_hierarchy`() = runTest {
    dispatch("""{"type":"request_hierarchy","requestId":"h1","disableAllFiltering":true}""")
    assertEquals(
      "requestHierarchy" to
        listOf<Any?>(RequestHierarchy(disableAllFiltering = true, requestId = "h1")),
      lastCall,
    )
  }

  @Test
  fun `hierarchy dispatch preserves nullable limits and display in the typed request`() = runTest {
    for (maxDepth in listOf(null, 0)) {
      for (maxNodes in listOf(null, 37)) {
        for (displayId in listOf(null, 2)) {
          assertTypedDispatch(
            """{"type":"request_hierarchy","requestId":"hierarchy","disableAllFiltering":true,"maxDepth":$maxDepth,"maxNodes":$maxNodes,"displayId":$displayId}""",
            "requestHierarchy" to
              listOf<Any?>(
                RequestHierarchy(
                  disableAllFiltering = true,
                  maxDepth = maxDepth,
                  maxNodes = maxNodes,
                  displayId = displayId,
                  requestId = "hierarchy",
                ),
              ),
          )
        }
      }
    }
    assertTypedDispatch(
      """{"type":"request_hierarchy"}""",
      "requestHierarchy" to
        listOf<Any?>(
          RequestHierarchy(
            disableAllFiltering = false,
            maxDepth = null,
            maxNodes = null,
            displayId = null,
            requestId = null,
          ),
        ),
    )
  }

  @Test
  fun `dispatches request_hierarchy_if_stale`() = runTest {
    dispatch("""{"type":"request_hierarchy_if_stale","requestId":"h2","sinceTimestamp":12345}""")
    assertEquals("requestHierarchyIfStale" to listOf<Any?>(12345L, "h2"), lastCall)
  }

  @Test
  fun `dispatches set_hierarchy_interval`() = runTest {
    dispatch("""{"type":"set_hierarchy_interval","intervalMs":500}""")
    assertEquals("setHierarchyInterval" to listOf<Any?>(500L), lastCall)
  }

  @Test
  fun `dispatches set_hierarchy_interval reset`() = runTest {
    dispatch("""{"type":"set_hierarchy_interval","intervalMs":null}""")
    assertEquals("setHierarchyInterval" to listOf<Any?>(null), lastCall)
  }

  @Test
  fun `dispatches request_screenshot`() = runTest {
    dispatch("""{"type":"request_screenshot","requestId":"s1"}""")
    assertEquals("requestScreenshot" to listOf<Any?>(RequestScreenshot(requestId = "s1")), lastCall)
  }

  @Test
  fun `dispatches request_screenshot hidePrototypes to the hide-capture-restore action`() =
    runTest {
      dispatch(
        """{"type":"request_screenshot","requestId":"s2","displayId":3,"hidePrototypes":true}""",
      )
      assertEquals(
        "requestScreenshot" to
          listOf<Any?>(RequestScreenshot(requestId = "s2", displayId = 3, hidePrototypes = true)),
        lastCall,
      )
    }

  @Test
  fun `screenshot dispatch preserves hidePrototypes and display`() = runTest {
    for (displayId in listOf(null, 3)) {
      for (hidePrototypes in listOf(false, true)) {
        val expected = listOf<Any?>(RequestScreenshot("screenshot", displayId, hidePrototypes))
        assertTypedDispatch(
          """{"type":"request_screenshot","requestId":"screenshot","displayId":$displayId,"hidePrototypes":$hidePrototypes}""",
          "requestScreenshot" to expected,
        )
      }
    }
    assertTypedDispatch(
      """{"type":"request_screenshot"}""",
      "requestScreenshot" to listOf<Any?>(RequestScreenshot(requestId = null, displayId = null)),
    )
  }

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

  // ---------------------------------------------------------------------------
  // Text input / actions
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches request_set_text`() = runTest {
    dispatch(
      """{"type":"request_set_text","requestId":"txt1","text":"Hello","resourceId":"field","dismissKeyboard":true}""",
    )
    assertEquals(
      "requestSetText" to
        listOf<Any?>(
          RequestSetText(
            requestId = "txt1",
            text = "Hello",
            resourceId = "field",
            dismissKeyboard = true,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `forwards frame context with request_set_text`() = runTest {
    dispatch(
      """{"type":"request_set_text","requestId":"txt1","text":"Hello","frameContext":"frame-1"}""",
    )
    assertEquals(
      "requestSetText" to
        listOf<Any?>(
          RequestSetText(
            requestId = "txt1",
            text = "Hello",
            resourceId = null,
            dismissKeyboard = false,
            frameContext = "frame-1",
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `framed set text dispatch preserves resource and keyboard arguments`() = runTest {
    assertTypedDispatch(
      """{"type":"request_set_text","requestId":"framed-text","text":"Hello","resourceId":"field","dismissKeyboard":true,"frameContext":"frame-text"}""",
      "requestSetText" to
        listOf<Any?>(
          RequestSetText(
            requestId = "framed-text",
            text = "Hello",
            resourceId = "field",
            dismissKeyboard = true,
            frameContext = "frame-text",
          ),
        ),
    )
  }

  @Test
  fun `request_insert_text with expectedSuffix routes the capability call`() = runTest {
    dispatch("""{"type":"request_insert_text","requestId":"id","text":"t","expectedSuffix":"ab"}""")
    assertEquals(
      "requestInsertText" to
        listOf<Any?>(
          RequestInsertText(
            requestId = "id",
            text = "t",
            expectedSuffix = "ab",
            acceptsCaretNotPlaced = false,
            precedingState = null,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `dispatches opted in request_insert_text`() = runTest {
    dispatch(
      """{"type":"request_insert_text","requestId":"id","text":"t","acceptsCaretNotPlaced":true}""",
    )
    assertEquals(
      "requestInsertText" to
        listOf<Any?>(
          RequestInsertText(
            requestId = "id",
            text = "t",
            expectedSuffix = null,
            acceptsCaretNotPlaced = true,
            precedingState = null,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_insert_text`() = runTest {
    dispatch("""{"type":"request_insert_text","requestId":"txt2","text":" world"}""")
    assertEquals(
      "requestInsertText" to
        listOf<Any?>(
          RequestInsertText(
            requestId = "txt2",
            text = " world",
            expectedSuffix = null,
            acceptsCaretNotPlaced = false,
            precedingState = null,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `insert text dispatch preserves all capability arguments together`() = runTest {
    assertTypedDispatch(
      """{"type":"request_insert_text","requestId":"insert","text":"😀","expectedSuffix":"x","acceptsCaretNotPlaced":true,"precedingState":{"text":"éx","isShowingHintText":true,"selectionStart":1,"selectionEnd":2}}""",
      "requestInsertText" to
        listOf<Any?>(
          RequestInsertText(
            requestId = "insert",
            text = "😀",
            expectedSuffix = "x",
            acceptsCaretNotPlaced = true,
            precedingState = dev.jasonpearson.automobile.protocol.InsertTextState("éx", true, 1, 2),
          ),
        ),
    )
  }

  @Test
  fun `dispatches pre-dispatch state read`() = runTest {
    dispatch("""{"type":"request_insert_text_state","requestId":"baseline"}""")
    assertEquals("requestInsertTextState" to listOf<Any?>("baseline"), lastCall)
  }

  @Test
  fun `dispatches optional pre-dispatch baseline`() = runTest {
    dispatch(
      """{"type":"request_insert_text","text":"😀","expectedSuffix":"x","precedingState":{"text":"éx","selectionStart":2,"selectionEnd":2}}""",
    )
    assertEquals(
      dev.jasonpearson.automobile.protocol.InsertTextState("éx", false, 2, 2),
      (lastCall.second.single() as RequestInsertText).precedingState,
    )
  }

  @Test
  fun `dispatches the optional IME commit budget`() = runTest {
    dispatch(
      """{"type":"request_commit_text","requestId":"commit-1","text":"long text","timeoutMs":14500}""",
    )
    assertEquals(
      "requestCommitText" to
        listOf<Any?>(
          RequestCommitText(
            requestId = "commit-1",
            text = "long text",
            priorImeId = null,
            delivery = ImeTextDelivery.COMMIT,
            timeoutMs = 14_500L,
          ),
        ),
      lastCall,
    )
    dispatch("""{"type":"request_commit_text","requestId":"commit-2","text":"short"}""")
    assertEquals(
      "requestCommitText" to
        listOf<Any?>(
          RequestCommitText(
            requestId = "commit-2",
            text = "short",
            priorImeId = null,
            delivery = ImeTextDelivery.COMMIT,
            timeoutMs = null,
          ),
        ),
      lastCall,
    )
    dispatch(
      """{"type":"request_commit_text","requestId":"commit-3","text":"abc","delivery":"keyEvents","timeoutMs":9000}""",
    )
    assertEquals(
      "requestCommitText" to
        listOf<Any?>(
          RequestCommitText(
            requestId = "commit-3",
            text = "abc",
            priorImeId = null,
            delivery = ImeTextDelivery.KEY_EVENTS,
            timeoutMs = 9_000L,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `commit text dispatch preserves delivery budget prior IME and trace together`() = runTest {
    for ((wireDelivery, delivery) in
      listOf(
        "commit" to ImeTextDelivery.COMMIT,
        "keyEvents" to ImeTextDelivery.KEY_EVENTS,
        "clearField" to ImeTextDelivery.CLEAR_FIELD,
      )) {
      for (timeout in listOf(null, 9000L)) {
        for (trace in listOf(false, true)) {
          assertTypedDispatch(
            """{"type":"request_commit_text","requestId":"commit","text":"value","priorImeId":"prior/ime","delivery":"$wireDelivery","timeoutMs":$timeout,"trace":$trace}""",
            "requestCommitText" to
              listOf<Any?>(
                RequestCommitText(
                  requestId = "commit",
                  text = "value",
                  priorImeId = "prior/ime",
                  delivery = delivery,
                  timeoutMs = timeout,
                  trace = trace,
                ),
              ),
          )
        }
      }
    }
    assertTypedDispatch(
      """{"type":"request_commit_text","text":"value"}""",
      "requestCommitText" to
        listOf<Any?>(
          RequestCommitText(
            requestId = null,
            text = "value",
            priorImeId = null,
            delivery = ImeTextDelivery.COMMIT,
            timeoutMs = null,
            trace = false,
          ),
        ),
    )
  }

  @Test
  fun `dispatches correlated IME cancellation`() = runTest {
    dispatch(
      """{"type":"request_cancel_ime_commit","requestId":"cancel-1","targetRequestId":"commit-1"}""",
    )
    assertEquals("requestCancelImeCommit" to listOf<Any?>("cancel-1", "commit-1"), lastCall)
  }

  @Test
  fun `dispatches request_set_keyboard_profile`() = runTest {
    dispatch(
      """{"type":"request_set_keyboard_profile","requestId":"profile-1","profileId":"gboard"}""",
    )
    assertEquals("requestSetKeyboardProfile" to listOf<Any?>("profile-1", "gboard"), lastCall)
  }

  @Test
  fun `dispatches request_list_keyboard_profiles with supported versions`() = runTest {
    dispatch(
      """{"type":"request_list_keyboard_profiles","requestId":"profiles-1","supportedCatalogVersions":[1]}""",
    )
    assertEquals("requestListKeyboardProfiles" to listOf<Any?>("profiles-1", listOf(1)), lastCall)
  }

  @Test
  fun `dispatches request_ime_action`() = runTest {
    dispatch("""{"type":"request_ime_action","requestId":"i1","action":"search"}""")
    assertEquals(
      "requestImeAction" to listOf<Any?>(RequestImeAction(requestId = "i1", action = "search")),
      lastCall,
    )
  }

  @Test
  fun `forwards frame context with request_ime_action`() = runTest {
    dispatch(
      """{"type":"request_ime_action","requestId":"i1","action":"search","frameContext":"frame-1"}""",
    )
    assertEquals(
      "requestImeAction" to
        listOf<Any?>(
          RequestImeAction(requestId = "i1", action = "search", frameContext = "frame-1"),
        ),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_click_focused_input`() = runTest {
    dispatch("""{"type":"request_click_focused_input","requestId":"fc1"}""")
    assertEquals("requestClickFocusedInput" to listOf<Any?>("fc1"), lastCall)
  }

  @Test
  fun `dispatches request_select_all`() = runTest {
    dispatch("""{"type":"request_select_all","requestId":"sa1"}""")
    assertEquals("requestSelectAll" to listOf<Any?>("sa1"), lastCall)
  }

  @Test
  fun `dispatches request_action`() = runTest {
    dispatch(
      """{"type":"request_action","requestId":"a1","action":"long_click","resourceId":"com.app:id/x"}""",
    )
    assertEquals(
      "requestAction" to listOf<Any?>("a1", "long_click", "com.app:id/x", null),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_action selector`() = runTest {
    dispatch(
      """{"type":"request_action","requestId":"a2","action":"long_click","selector":{"testTag":"message_row_42","collectionRow":4,"collectionColumn":0}}""",
    )
    assertEquals(
      "requestAction" to
        listOf<Any?>(
          "a2",
          "long_click",
          null,
          dev.jasonpearson.automobile.protocol.NodeSelector(
            testTag = "message_row_42",
            collectionRow = 4,
            collectionColumn = 0,
          ),
        ),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_clipboard`() = runTest {
    dispatch("""{"type":"request_clipboard","requestId":"c1","action":"copy","text":"hi"}""")
    assertEquals("requestClipboard" to listOf<Any?>("c1", "copy", "hi"), lastCall)
  }

  // ---------------------------------------------------------------------------
  // Certificates / permissions / device
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches install_ca_cert`() = runTest {
    dispatch("""{"type":"install_ca_cert","requestId":"cc1","certificate":"PEMDATA"}""")
    assertEquals("installCaCert" to listOf<Any?>("cc1", "PEMDATA"), lastCall)
  }

  @Test
  fun `install_ca_cert with blank certificate is ignored`() = runTest {
    dispatch("""{"type":"install_ca_cert","requestId":"cc2","certificate":""}""")
    assertTrue("no action should fire", calls.isEmpty())
    assertEquals(1, logs.size)
    assertTrue(logs[0], logs[0].contains("install_ca_cert missing certificate"))
  }

  @Test
  fun `dispatches install_ca_cert_from_path`() = runTest {
    dispatch(
      """{"type":"install_ca_cert_from_path","requestId":"cp1","devicePath":"/sdcard/cert.pem"}""",
    )
    assertEquals("installCaCertFromPath" to listOf<Any?>("cp1", "/sdcard/cert.pem"), lastCall)
  }

  @Test
  fun `install_ca_cert_from_path with blank devicePath is ignored`() = runTest {
    dispatch("""{"type":"install_ca_cert_from_path","requestId":"cp2","devicePath":""}""")
    assertTrue("no action should fire", calls.isEmpty())
    assertEquals(1, logs.size)
    assertTrue(logs[0], logs[0].contains("install_ca_cert_from_path missing devicePath"))
  }

  @Test
  fun `dispatches remove_ca_cert with alias only`() = runTest {
    dispatch("""{"type":"remove_ca_cert","requestId":"rc1","alias":"myalias"}""")
    assertEquals("removeCaCert" to listOf<Any?>("rc1", "myalias", null), lastCall)
  }

  @Test
  fun `dispatches remove_ca_cert with certificate only`() = runTest {
    dispatch("""{"type":"remove_ca_cert","requestId":"rc3","certificate":"cert-pem"}""")
    assertEquals("removeCaCert" to listOf<Any?>("rc3", null, "cert-pem"), lastCall)
  }

  @Test
  fun `dispatches remove_ca_cert with both alias and certificate`() = runTest {
    dispatch(
      """{"type":"remove_ca_cert","requestId":"rc4","alias":"myalias","certificate":"cert-pem"}""",
    )
    assertEquals("removeCaCert" to listOf<Any?>("rc4", "myalias", "cert-pem"), lastCall)
  }

  @Test
  fun `remove_ca_cert with neither alias nor certificate is ignored`() = runTest {
    dispatch("""{"type":"remove_ca_cert","requestId":"rc2"}""")
    assertTrue(calls.isEmpty())
    assertEquals(1, logs.size)
    assertTrue(logs[0], logs[0].contains("remove_ca_cert missing alias and certificate"))
  }

  @Test
  fun `dispatches request_global_action`() = runTest {
    dispatch("""{"type":"request_global_action","requestId":"g1","action":"back"}""")
    assertEquals(
      "requestGlobalAction" to listOf<Any?>(RequestGlobalAction(requestId = "g1", action = "back")),
      lastCall,
    )
  }

  @Test
  fun `dispatches validate_frame_context`() = runTest {
    dispatch(
      """{"type":"validate_frame_context","requestId":"context-1","frameContext":"epoch:4"}""",
    )
    assertEquals("validateFrameContext" to listOf<Any?>("context-1", "epoch:4"), lastCall)
  }

  @Test
  fun `forwards frame context with request_global_action`() = runTest {
    dispatch(
      """{"type":"request_global_action","requestId":"g1","action":"back","frameContext":"frame-1"}""",
    )
    assertEquals(
      "requestGlobalAction" to
        listOf<Any?>(
          RequestGlobalAction(requestId = "g1", action = "back", frameContext = "frame-1"),
        ),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_device_info`() = runTest {
    dispatch("""{"type":"request_device_info","requestId":"di1"}""")
    assertEquals("requestDeviceInfo" to listOf<Any?>("di1"), lastCall)
  }

  @Test
  fun `dispatches get_device_owner_status`() = runTest {
    dispatch("""{"type":"get_device_owner_status","requestId":"do1"}""")
    assertEquals("getDeviceOwnerStatus" to listOf<Any?>("do1"), lastCall)
  }

  @Test
  fun `dispatches get_permission`() = runTest {
    dispatch(
      """{"type":"get_permission","requestId":"p1","permission":"android.permission.CAMERA","requestPermission":true}""",
    )
    assertEquals(
      "getPermission" to listOf<Any?>("p1", "android.permission.CAMERA", true),
      lastCall,
    )
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches set_recomposition_tracking`() = runTest {
    dispatch("""{"type":"set_recomposition_tracking","requestId":"rt1","enabled":true}""")
    assertEquals("setRecompositionTracking" to listOf<Any?>(true), lastCall)
  }

  @Test
  fun `dispatches set_accessibility_flags`() = runTest {
    dispatch(
      """{"type":"set_accessibility_flags","includeNotImportantViews":false,"reportViewIds":true,"retrieveInteractiveWindows":false,"occlusionEnabled":false}""",
    )
    assertEquals("setAccessibilityFlags" to listOf<Any?>(false, true, false, false), lastCall)
  }

  @Test
  fun `set_accessibility_flags defaults all flags to true`() = runTest {
    dispatch("""{"type":"set_accessibility_flags"}""")
    assertEquals("setAccessibilityFlags" to listOf<Any?>(true, true, true, true), lastCall)
  }

  @Test
  fun `dispatches set_network_mock_rules re-encoding rules to JSON`() = runTest {
    dispatch(
      """{"type":"set_network_mock_rules","rules":[{"mockId":"m1","host":"example.com","path":"/api","method":"GET","statusCode":200}]}""",
    )
    assertEquals("setNetworkMockRules", lastCall.first)
    val rulesJson = lastCall.second[0] as String
    val rules = json.decodeFromString(ListSerializer(NetworkMockRuleDto.serializer()), rulesJson)
    assertEquals(1, rules.size)
    assertEquals("m1", rules[0].mockId)
    assertEquals("example.com", rules[0].host)
    assertEquals(200, rules[0].statusCode)
  }

  @Test
  fun `set_network_mock_rules passes its requestId so the rejected-rule report can be routed`() =
    runTest {
      dispatch("""{"type":"set_network_mock_rules","requestId":"mock-7","rules":[]}""")
      assertEquals("setNetworkMockRules", lastCall.first)
      assertEquals("mock-7", lastCall.second[1])

      dispatch("""{"type":"set_network_mock_rules","rules":[]}""")
      assertEquals(null, lastCall.second[1])
    }

  @Test
  fun `dispatches set_network_error_simulation`() = runTest {
    dispatch(
      """{"type":"set_network_error_simulation","enabled":true,"errorType":"timeout","limit":5,"expiresAtEpochMs":99999}""",
    )
    assertEquals(
      "setNetworkErrorSimulation" to listOf<Any?>(true, "timeout", 5, 99999L, null),
      lastCall,
    )
  }

  @Test
  fun `dispatches set_network_error_simulation remainingMs`() = runTest {
    dispatch(
      """{"type":"set_network_error_simulation","enabled":true,"errorType":"timeout","expiresAtEpochMs":99999,"remainingMs":30000}""",
    )
    assertEquals(
      "setNetworkErrorSimulation" to listOf<Any?>(true, "timeout", null, 99999L, 30000L),
      lastCall,
    )
  }

  // ---------------------------------------------------------------------------
  // Accessibility focus / highlight
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches get_current_focus`() = runTest {
    dispatch("""{"type":"get_current_focus","requestId":"f1"}""")
    assertEquals("getCurrentFocus" to listOf<Any?>("f1"), lastCall)
  }

  @Test
  fun `dispatches get_traversal_order`() = runTest {
    dispatch("""{"type":"get_traversal_order","requestId":"to1"}""")
    assertEquals("getTraversalOrder" to listOf<Any?>("to1"), lastCall)
  }

  @Test
  fun `dispatches add_highlight converting the protocol shape to the render model`() = runTest {
    dispatch(
      """{"type":"add_highlight","requestId":"hl1","id":"highlight-1","shape":{"type":"circle","bounds":{"x":10,"y":20,"width":100,"height":50}}}""",
    )
    assertEquals("addHighlight", lastCall.first)
    assertEquals("hl1", lastCall.second[0])
    assertEquals("highlight-1", lastCall.second[1])
    val shape = lastCall.second[2] as HighlightShape
    assertEquals("circle", shape.type)
    assertEquals(100, shape.bounds?.width)
    assertEquals(50, shape.bounds?.height)
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches list_preference_files`() = runTest {
    dispatch("""{"type":"list_preference_files","requestId":"lf1","packageName":"com.example"}""")
    assertEquals("listPreferenceFiles" to listOf<Any?>("lf1", "com.example"), lastCall)
  }

  @Test
  fun `dispatches get_preferences`() = runTest {
    dispatch(
      """{"type":"get_preferences","requestId":"gp1","packageName":"com.example","fileName":"settings.xml"}""",
    )
    assertEquals("getPreferences" to listOf<Any?>("gp1", "com.example", "settings.xml"), lastCall)
  }

  @Test
  fun `dispatches read only keystore discovery`() = runTest {
    dispatch("""{"type":"discover_keystore","requestId":"ks1","packageName":"com.example"}""")
    assertEquals("discoverKeystore" to listOf<Any?>("ks1", "com.example"), lastCall)
  }

  @Test
  fun `dispatches get_sdk_capabilities`() = runTest {
    dispatch("""{"type":"get_sdk_capabilities","requestId":"sc1","packageName":"com.example"}""")
    assertEquals("getSdkCapabilities" to listOf<Any?>("sc1", "com.example", null), lastCall)
  }

  @Test
  fun `dispatches get_sdk_capabilities with a target user`() = runTest {
    dispatch(
      """{"type":"get_sdk_capabilities","requestId":"sc2","packageName":"com.example","userId":10}""",
    )
    assertEquals("getSdkCapabilities" to listOf<Any?>("sc2", "com.example", 10), lastCall)
  }

  @Test
  fun `dispatches list_data_stores`() = runTest {
    dispatch(
      """{"type":"list_data_stores","requestId":"lds1","packageName":"com.example","adapterName":"settings"}""",
    )
    assertEquals("listDataStores" to listOf<Any?>("lds1", "com.example", "settings"), lastCall)
  }

  @Test
  fun `dispatches get_data_store`() = runTest {
    dispatch(
      """{"type":"get_data_store","requestId":"gds1","packageName":"com.example","adapterName":"settings","storeName":"user_prefs"}""",
    )
    assertEquals(
      "getDataStore" to listOf<Any?>("gds1", "com.example", "settings", "user_prefs"),
      lastCall,
    )
  }

  @Test
  fun `dispatches subscribe_storage`() = runTest {
    dispatch(
      """{"type":"subscribe_storage","requestId":"sub1","packageName":"com.example","fileName":"settings.xml"}""",
    )
    assertEquals(
      "subscribeStorage" to listOf<Any?>("sub1", "com.example", "settings.xml"),
      lastCall,
    )
  }

  @Test
  fun `unsubscribe_storage with only subscriptionId resolves packageName and fileName`() = runTest {
    // Real TS traffic sends only the subscriptionId ("packageName:fileName"). The handler must
    // split
    // it and dispatch the unsubscribe so the device actually tears down the subscription.
    dispatch(
      """{"type":"unsubscribe_storage","requestId":"unsub1","subscriptionId":"com.example:settings.xml"}""",
    )
    assertEquals(
      "unsubscribeStorage" to listOf<Any?>("unsub1", "com.example", "settings.xml"),
      lastCall,
    )
    assertTrue("no diagnostic log expected for a resolvable subscriptionId", logs.isEmpty())
  }

  @Test
  fun `unsubscribe_storage splits subscriptionId on the first colon only`() = runTest {
    // subscriptionId = "packageName:fileName"; a file name may itself contain ':', so only the
    // first
    // ':' delimits packageName from fileName.
    dispatch(
      """{"type":"unsubscribe_storage","requestId":"unsub3","subscriptionId":"com.example:weird:name.xml"}""",
    )
    assertEquals(
      "unsubscribeStorage" to listOf<Any?>("unsub3", "com.example", "weird:name.xml"),
      lastCall,
    )
  }

  @Test
  fun `unsubscribe_storage with a malformed subscriptionId is a logged no-op`() = runTest {
    dispatch("""{"type":"unsubscribe_storage","requestId":"unsub4","subscriptionId":"nocolon"}""")
    assertTrue("no action should fire for an unsplittable subscriptionId", calls.isEmpty())
    assertEquals(1, logs.size)
    assertTrue(logs[0], logs[0].contains("malformed subscriptionId=nocolon"))
  }

  @Test
  fun `unsubscribe_storage rejects an empty package or file segment as malformed`() = runTest {
    // A real subscription can never have an empty package or file, so these are unsplittable.
    dispatch(
      """{"type":"unsubscribe_storage","requestId":"unsub5","subscriptionId":":settings.xml"}""",
    )
    dispatch(
      """{"type":"unsubscribe_storage","requestId":"unsub6","subscriptionId":"com.example:"}""",
    )
    assertTrue("no action should fire for an empty-segment subscriptionId", calls.isEmpty())
    assertEquals(2, logs.size)
    assertTrue(logs[0], logs[0].contains("malformed subscriptionId=:settings.xml"))
    assertTrue(logs[1], logs[1].contains("malformed subscriptionId=com.example:"))
  }

  @Test
  fun `unsubscribe_storage prefers explicit packageName and fileName over subscriptionId`() =
    runTest {
      // If a client ever sends both, the explicit fields are authoritative over the parsed id.
      dispatch(
        """{"type":"unsubscribe_storage","requestId":"unsub7","subscriptionId":"other.pkg:other.xml","packageName":"com.example","fileName":"settings.xml"}""",
      )
      assertEquals(
        "unsubscribeStorage" to listOf<Any?>("unsub7", "com.example", "settings.xml"),
        lastCall,
      )
    }

  @Test
  fun `unsubscribe_storage without any identifier is a logged no-op`() = runTest {
    dispatch("""{"type":"unsubscribe_storage","requestId":"unsub8"}""")
    assertTrue("no action should fire without any identifier", calls.isEmpty())
    assertEquals(1, logs.size)
    assertTrue(logs[0], logs[0].contains("without subscriptionId or packageName/fileName"))
  }

  @Test
  fun `unsubscribe_storage with packageName and fileName invokes the action`() = runTest {
    dispatch(
      """{"type":"unsubscribe_storage","requestId":"unsub2","packageName":"com.example","fileName":"settings.xml"}""",
    )
    assertEquals(
      "unsubscribeStorage" to listOf<Any?>("unsub2", "com.example", "settings.xml"),
      lastCall,
    )
  }

  @Test
  fun `dispatches get_preference`() = runTest {
    dispatch(
      """{"type":"get_preference","requestId":"gpr1","packageName":"com.example","fileName":"settings.xml","key":"theme"}""",
    )
    assertEquals(
      "getPreference" to listOf<Any?>("gpr1", "com.example", "settings.xml", "theme"),
      lastCall,
    )
  }

  @Test
  fun `dispatches set_preference`() = runTest {
    dispatch(
      """{"type":"set_preference","requestId":"spr1","packageName":"com.example","fileName":"settings.xml","key":"theme","value":"dark","valueType":"string"}""",
    )
    assertEquals(
      "setPreference" to
        listOf<Any?>("spr1", "com.example", "settings.xml", "theme", "dark", "string"),
      lastCall,
    )
  }

  @Test
  fun `dispatches remove_preference`() = runTest {
    dispatch(
      """{"type":"remove_preference","requestId":"rp1","packageName":"com.example","fileName":"settings.xml","key":"theme"}""",
    )
    assertEquals(
      "removePreference" to listOf<Any?>("rp1", "com.example", "settings.xml", "theme"),
      lastCall,
    )
  }

  @Test
  fun `dispatches clear_preferences`() = runTest {
    dispatch(
      """{"type":"clear_preferences","requestId":"clp1","packageName":"com.example","fileName":"settings.xml"}""",
    )
    assertEquals(
      "clearPreferences" to listOf<Any?>("clp1", "com.example", "settings.xml"),
      lastCall,
    )
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches request_settings_get`() = runTest {
    dispatch(
      """{"type":"request_settings_get","requestId":"sg1","namespace":"system","key":"user_rotation"}""",
    )
    assertEquals("requestSettingsGet" to listOf<Any?>("sg1", "system", "user_rotation"), lastCall)
  }

  @Test
  fun `dispatches request_settings_put`() = runTest {
    dispatch(
      """{"type":"request_settings_put","requestId":"sp1","namespace":"system","key":"user_rotation","value":"1","valueType":"int"}""",
    )
    assertEquals(
      "requestSettingsPut" to listOf<Any?>("sp1", "system", "user_rotation", "1", "int"),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_settings_list`() = runTest {
    dispatch("""{"type":"request_settings_list","requestId":"sl1","namespace":"global"}""")
    assertEquals("requestSettingsList" to listOf<Any?>("sl1", "global"), lastCall)
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  @Test
  fun `accepts start_recording without a response`() = runTest {
    assertNull(dispatchForResponse("""{"type":"start_recording"}"""))
    assertEquals("startRecording" to emptyList<Any?>(), lastCall)
  }

  @Test
  fun `accepts stop_recording without a response`() = runTest {
    assertNull(dispatchForResponse("""{"type":"stop_recording"}"""))
    assertEquals("stopRecording" to emptyList<Any?>(), lastCall)
  }

  // ---------------------------------------------------------------------------
  // Package manager
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches request_installed_packages`() = runTest {
    dispatch(
      """{"type":"request_installed_packages","requestId":"ip1","includeSystem":false,"userId":10}""",
    )
    assertEquals("requestInstalledPackages" to listOf<Any?>("ip1", false, 10), lastCall)
  }

  @Test
  fun `dispatches request_package_info`() = runTest {
    dispatch(
      """{"type":"request_package_info","requestId":"pin1","packageName":"com.example","includePermissions":true}""",
    )
    assertEquals("requestPackageInfo" to listOf<Any?>("pin1", "com.example", true), lastCall)
  }

  @Test
  fun `dispatches request_launch_intent`() = runTest {
    dispatch("""{"type":"request_launch_intent","requestId":"li1","packageName":"com.example"}""")
    assertEquals("requestLaunchIntent" to listOf<Any?>("li1", "com.example"), lastCall)
  }

  // ---------------------------------------------------------------------------
  // Ahead-of-need: request_hit_test decodes but has no wired device action
  // ---------------------------------------------------------------------------

  @Test
  fun `request_hit_test is decoded but not dispatched to any action`() = runTest {
    dispatch("""{"type":"request_hit_test","requestId":"ht1","x":320,"y":720}""")
    assertTrue("no action should fire for the ahead-of-need type", calls.isEmpty())
    assertEquals(1, logs.size)
    assertTrue(logs[0], logs[0].contains("request_hit_test received"))
    assertTrue(logs[0], logs[0].contains("requestId=ht1"))
  }

  // ---------------------------------------------------------------------------
  // Fire-and-forget contract + partial construction
  // ---------------------------------------------------------------------------

  @Test
  fun `handleMessage returns null for every command (fire-and-forget)`() = runTest {
    // A spread across categories, including the branches that do extra work: shape conversion,
    // rule re-encoding, the ahead-of-need type, recording, and the subscriptionId-only unsubscribe.
    val messages =
      listOf(
        """{"type":"request_screenshot","requestId":"s1"}""",
        """{"type":"request_tap_coordinates","requestId":"t1","x":1,"y":2}""",
        """{"type":"add_highlight","requestId":"h1","id":"x","shape":{"type":"circle","bounds":{"x":0,"y":0,"width":1,"height":1}}}""",
        """{"type":"set_network_mock_rules","rules":[]}""",
        """{"type":"request_hit_test","requestId":"ht","x":1,"y":2}""",
        """{"type":"start_recording"}""",
        """{"type":"unsubscribe_storage","requestId":"u","subscriptionId":"a:b"}""",
      )
    for (message in messages) {
      val response = handler.handleMessage(json.decodeFromString<WebSocketRequest>(message))
      assertEquals("null expected for $message", null, response)
    }
  }

  @Test
  fun `no-op actions ignore commands without crashing`() = runTest {
    // NoOpCtrlProxyActions implements every action as a no-op — a decoded command must dispatch
    // cleanly (the compiler already guarantees every action is implemented).
    val noOpHandler = CtrlProxyMessageHandler(NoOpCtrlProxyActions(), log = { logs.add(it) })
    val messages =
      listOf(
        """{"type":"request_screenshot","requestId":"s1"}""",
        """{"type":"request_swipe","requestId":"sw1","x1":0,"y1":0,"x2":1,"y2":1}""",
        """{"type":"add_highlight","requestId":"h1","id":"x","shape":{"type":"circle","bounds":{"x":0,"y":0,"width":1,"height":1}}}""",
        """{"type":"set_network_mock_rules","rules":[]}""",
        """{"type":"start_recording"}""",
      )
    for (message in messages) {
      val response = noOpHandler.handleMessage(json.decodeFromString<WebSocketRequest>(message))
      assertEquals(null, response)
    }
    assertTrue("recording fake must be untouched by the no-op handler", calls.isEmpty())
  }

  @Test
  fun `dispatch typed prototype requests`() = runTest {
    val spec =
      """{"id":"panel","window":{"placement":{"type":"fullscreen"},"opacity":90},"root":{"type":"text","text":"Hello"}}"""
    dispatch("""{"type":"show_prototype","requestId":"s","spec":$spec}""")
    assertEquals("showPrototype", lastCall.first)
    assertEquals("s", lastCall.second[0])
    assertEquals("panel", (lastCall.second[1] as PrototypeSpec).id)
    assertEquals(PrototypeTextNode(text = "Hello"), (lastCall.second[1] as PrototypeSpec).root)
    assertEquals(false, lastCall.second[3])
    assertEquals(true, lastCall.second[5])
    dispatch("""{"type":"show_prototype","requestId":"add","spec":$spec,"replaceOthers":false}""")
    assertEquals(false, lastCall.second[5])
    dispatch("""{"type":"show_prototype","requestId":"r","spec":$spec,"reset":true}""")
    assertEquals("showPrototype", lastCall.first)
    assertEquals(true, lastCall.second[3])
    dispatch("""{"type":"dismiss_prototype","requestId":"d","id":"panel"}""")
    assertEquals("dismissPrototype", lastCall.first)
    assertEquals(listOf("d", "panel", null), lastCall.second)
    dispatch("""{"type":"dismiss_prototype","requestId":"a","all":true}""")
    assertEquals(listOf("a", null, true), lastCall.second)
  }

  @Test
  fun `show_prototype carries an absent or explicit displayId to the action`() = runTest {
    val spec =
      """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hi"}}"""
    dispatch("""{"type":"show_prototype","requestId":"s","spec":$spec}""")
    assertNull(lastCall.second[2])
    dispatch("""{"type":"show_prototype","requestId":"s","spec":$spec,"displayId":null}""")
    assertNull(lastCall.second[2])
    // The handler's default SDK is Build.VERSION.SDK_INT (0 off-device); API 30+ may route.
    val api30 = CtrlProxyMessageHandler(actions, sdkInt = { 30 })
    api30.handleMessage(
      json.decodeFromString<WebSocketRequest>(
        """{"type":"show_prototype","requestId":"s","spec":$spec,"displayId":2}""",
      ),
    )
    assertEquals("showPrototype", lastCall.first)
    assertEquals(2, lastCall.second[2])
  }

  @Test
  fun `show_prototype rejects an unroutable displayId with a correlated result and no action`() =
    runTest {
      val spec =
        """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hi"}}"""
      for ((sdk, displayId) in listOf(29 to 7, 29 to -1, 30 to -1)) {
        val before = calls.size
        val response =
          CtrlProxyMessageHandler(actions, sdkInt = { sdk })
            .handleMessage(
              json.decodeFromString<WebSocketRequest>(
                """{"type":"show_prototype","requestId":"s","spec":$spec,"displayId":$displayId}""",
              ),
            )
        assertTrue(response is PrototypeResult)
        response as PrototypeResult
        assertFalse(response.success)
        assertEquals("s", response.requestId)
        assertTrue(response.error.orEmpty().contains("display", ignoreCase = true))
        assertEquals("No action on API $sdk displayId $displayId", before, calls.size)
      }
      // Display 0 is the default display on every API level.
      CtrlProxyMessageHandler(actions, sdkInt = { 29 })
        .handleMessage(
          json.decodeFromString<WebSocketRequest>(
            """{"type":"show_prototype","requestId":"s","spec":$spec,"displayId":0}""",
          ),
        )
      assertEquals("showPrototype", lastCall.first)
      assertEquals(0, lastCall.second[2])
    }

  @Test
  fun `patch prototype dispatches asynchronously with every patch field`() = runTest {
    val response =
      dispatchForResponse(
        """{"type":"patch_prototype","requestId":"r9","id":"orders","baseRevision":12,"ops":[{"op":"replace","path":"/data/cartCount","value":2}]}""",
      )
    assertNull(response)
    assertEquals("patchPrototype", lastCall.first)
    assertEquals(listOf("r9", "orders", 12L), lastCall.second.take(3))
    assertEquals(
      kotlinx.serialization.json.Json.parseToJsonElement(
        """[{"op":"replace","path":"/data/cartCount","value":2}]""",
      ),
      lastCall.second[3],
    )
  }

  @Test
  fun `dispatch saved prototype requests with all arguments`() = runTest {
    val spec =
      """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hello"}}"""
    dispatch(
      """{"type":"save_prototype","requestId":"save","spec":$spec,"label":"Panel","icon":"icon"}""",
    )
    assertEquals("savePrototype", lastCall.first)
    assertEquals(
      listOf("save", json.decodeFromString<PrototypeSpec>(spec), "Panel", "icon"),
      lastCall.second,
    )
    dispatch("""{"type":"save_prototype","spec":$spec,"label":"Panel"}""")
    assertEquals(
      listOf(null, json.decodeFromString<PrototypeSpec>(spec), "Panel", null),
      lastCall.second,
    )
    dispatch("""{"type":"pin_saved_prototype","requestId":"pin","id":"panel","icon":"icon"}""")
    assertEquals("pinSavedPrototype", lastCall.first)
    assertEquals(listOf("pin", "panel", "icon"), lastCall.second)
    dispatch("""{"type":"pin_saved_prototype","id":"panel"}""")
    assertEquals(listOf(null, "panel", null), lastCall.second)
    dispatch("""{"type":"list_saved_prototypes","requestId":"list"}""")
    assertEquals("listSavedPrototypes", lastCall.first)
    assertEquals(listOf("list"), lastCall.second)
    dispatch("""{"type":"delete_saved_prototype","requestId":"delete","id":"panel"}""")
    assertEquals("deleteSavedPrototype", lastCall.first)
    assertEquals(listOf("delete", "panel"), lastCall.second)
  }

  @Test
  fun `dispatch inspect prototypes request`() = runTest {
    dispatch("""{"type":"inspect_prototypes","requestId":"i"}""")
    assertEquals("inspectPrototypes", lastCall.first)
    assertEquals(listOf<Any?>("i"), lastCall.second)
  }

  @Test
  fun `dispatch typed prototype asset requests`() = runTest {
    dispatch(
      """{"type":"put_prototype_asset","requestId":"p","id":"hero","mimeType":"image/png","dataBase64":"iVBORw0KGgo="}""",
    )
    assertEquals("putPrototypeAsset", lastCall.first)
    assertEquals(listOf("p", "hero", "image/png", "iVBORw0KGgo="), lastCall.second)
    dispatch("""{"type":"remove_prototype_asset","requestId":"r","id":"hero"}""")
    assertEquals("removePrototypeAsset", lastCall.first)
    assertEquals(listOf("r", "hero"), lastCall.second)
  }

  @Test
  fun `invalid prototype combinations return precise correlated failures without actions`() =
    runTest {
      val spec =
        """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hello"}}"""
      val dismissError = "dismiss_prototype requires exactly one of id or all:true"
      val cases =
        listOf(
          """{"type":"dismiss_prototype","requestId":"bad"}""" to dismissError,
          """{"type":"dismiss_prototype","requestId":"bad","id":"panel","all":true}""" to
            dismissError,
          """{"type":"dismiss_prototype","requestId":"bad","all":false}""" to dismissError,
          """{"type":"dismiss_prototype","requestId":"bad","id":"panel","all":false}""" to
            dismissError,
        )
      for ((literal, error) in cases) {
        val result = dispatchForResponse(literal) as PrototypeResult
        assertEquals("bad", result.requestId)
        assertFalse(result.success)
        assertEquals(error, result.error)
      }
      assertTrue(calls.isEmpty())
    }

  @Test
  fun `prototype result frame carries failure and escaped echoed request id`() {
    val requestId = "quoted" + '"'
    val result =
      json.decodeFromString<WebSocketResponse>(
        prototypeResultFrame(requestId, false, "render failed"),
      ) as PrototypeResult
    assertEquals(requestId, result.requestId)
    assertFalse(result.success)
    assertEquals("render failed", result.error)
  }
}

/** Service-level differences that the Android-free dispatch recorder cannot observe. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class CtrlProxyActionOverloadServiceTest {
  private lateinit var fixture: CtrlProxyGestureServiceFixture
  private val json = Json { ignoreUnknownKeys = true }

  @Before
  fun setUp() {
    fixture = CtrlProxyGestureServiceFixture()
  }

  @After
  fun tearDown() {
    fixture.close()
  }

  private class RecordingTransport : WebSocketServer.ClientTransport {
    val messages = mutableListOf<String>()

    override suspend fun send(message: String) {
      messages.add(message)
    }

    override suspend fun close(reason: CloseReason) = Unit
  }

  private fun recordResults(scope: CoroutineScope): List<String> {
    ReflectionHelpers.getField<CoroutineScope>(fixture.service, "serviceScope").cancel()
    ReflectionHelpers.setField(fixture.service, "serviceScope", scope)
    val server = WebSocketServer(scope = scope)
    // Like CtrlProxyHierarchyRequestTest: mark running with an unstarted engine. No listener,
    // connection, logcat, or device is started; results go only to the in-memory transport.
    ReflectionHelpers.setField(server, "server", embeddedServer(CIO, port = 0) {})
    ReflectionHelpers.setField(fixture.service, "webSocketServer", server)
    // The original runner captured the scope which the gesture fixture cancelled at construction.
    ReflectionHelpers.setField(
      fixture.service,
      "asyncActionRunner",
      AsyncActionRunner(scope, broadcastResponse = { server.broadcast(it) }),
    )
    val transport = RecordingTransport()
    server.registerClient(1, transport)
    return transport.messages
  }

  private fun resultSince(messages: List<String>, before: Int, type: String): JsonObject {
    val result = json.parseToJsonElement(messages.drop(before).single()).jsonObject
    assertEquals(type, result["type"]?.jsonPrimitive?.content)
    return result
  }

  @Test
  fun `set text unframed and fresh requests clear caret but stale frame preserves it`() = runTest {
    val messages = recordResults(backgroundScope)
    val fresh = fixture.freshFrameContext()
    for (mode in listOf("legacy", "null", "fresh", "stale")) {
      val before = messages.size
      val caret = fixture.seedCaret()
      when (mode) {
        "legacy" ->
          fixture.actions.requestSetText(
            RequestSetText(
              requestId = null,
              text = "value",
              resourceId = null,
              dismissKeyboard = false,
            ),
          )
        "null" ->
          fixture.actions.requestSetText(
            RequestSetText(
              requestId = null,
              text = "value",
              resourceId = null,
              dismissKeyboard = false,
              frameContext = null,
            ),
          )
        "fresh" ->
          fixture.actions.requestSetText(
            RequestSetText(
              requestId = null,
              text = "value",
              resourceId = null,
              dismissKeyboard = false,
              frameContext = fresh,
            ),
          )
        else ->
          fixture.actions.requestSetText(
            RequestSetText(
              requestId = null,
              text = "value",
              resourceId = null,
              dismissKeyboard = false,
              frameContext = "$fresh:stale",
            ),
          )
      }
      if (mode == "stale") assertSame(caret, fixture.rememberedCaret())
      else assertNull(fixture.rememberedCaret())
      runCurrent()
      val result = resultSince(messages, before, "set_text_result")
      assertEquals(false, result["success"]?.jsonPrimitive?.boolean)
      assertEquals(
        if (mode == "stale")
          "Stale frame context for input/set_text; observe a fresh frame before retrying"
        else "No focused editable node found",
        result["error"]?.jsonPrimitive?.content,
      )
    }
  }

  @Test
  fun `IME action unframed and fresh requests clear caret but stale frame preserves it`() =
    runTest {
      val messages = recordResults(backgroundScope)
      val fresh = fixture.freshFrameContext()
      for (mode in listOf("legacy", "null", "fresh", "stale")) {
        val before = messages.size
        val caret = fixture.seedCaret()
        when (mode) {
          "legacy" ->
            fixture.actions.requestImeAction(RequestImeAction(requestId = null, action = "search"))
          "null" ->
            fixture.actions.requestImeAction(
              RequestImeAction(requestId = null, action = "search", frameContext = null),
            )
          "fresh" ->
            fixture.actions.requestImeAction(
              RequestImeAction(requestId = null, action = "search", frameContext = fresh),
            )
          else ->
            fixture.actions.requestImeAction(
              RequestImeAction(requestId = null, action = "search", frameContext = "$fresh:stale"),
            )
        }
        if (mode == "stale") assertSame(caret, fixture.rememberedCaret())
        else assertNull(fixture.rememberedCaret())
        runCurrent()
        val result = resultSince(messages, before, "ime_action_result")
        assertEquals(false, result["success"]?.jsonPrimitive?.boolean)
        // The rejection echoes the family name; normal execution echoes the requested IME action.
        assertEquals(
          if (mode == "stale") "ime_action" else "search",
          result["action"]?.jsonPrimitive?.content,
        )
        assertEquals(
          if (mode == "stale")
            "Stale frame context for input/ime_action; observe a fresh frame before retrying"
          else "No focused editable node found for IME action",
          result["error"]?.jsonPrimitive?.content,
        )
      }
    }

  @Test
  fun `global action unframed and fresh requests clear caret but stale frame preserves it`() =
    runTest {
      val messages = recordResults(backgroundScope)
      val fresh = fixture.freshFrameContext()
      for (mode in listOf("legacy", "null", "fresh", "stale")) {
        val before = messages.size
        val globalActionsBefore = fixture.shadow.globalActionsPerformed.size
        val caret = fixture.seedCaret()
        when (mode) {
          "legacy" ->
            fixture.actions.requestGlobalAction(
              RequestGlobalAction(requestId = null, action = "back"),
            )
          "null" ->
            fixture.actions.requestGlobalAction(
              RequestGlobalAction(requestId = null, action = "back", frameContext = null),
            )
          "fresh" ->
            fixture.actions.requestGlobalAction(
              RequestGlobalAction(requestId = null, action = "back", frameContext = fresh),
            )
          else ->
            fixture.actions.requestGlobalAction(
              RequestGlobalAction(requestId = null, action = "back", frameContext = "$fresh:stale"),
            )
        }
        if (mode == "stale") assertSame(caret, fixture.rememberedCaret())
        else assertNull(fixture.rememberedCaret())
        assertEquals(
          if (mode == "stale") emptyList<Int>()
          else listOf(AccessibilityService.GLOBAL_ACTION_BACK),
          fixture.shadow.globalActionsPerformed.drop(globalActionsBefore),
        )
        runCurrent()
        val result = resultSince(messages, before, "global_action_result")
        assertEquals(
          if (mode == "stale") "global_action" else "back",
          result["action"]?.jsonPrimitive?.content,
        )
        if (mode == "stale") {
          assertEquals(false, result["success"]?.jsonPrimitive?.boolean)
          assertEquals(
            "Stale frame context for input/global_action; observe a fresh frame before retrying",
            result["error"]?.jsonPrimitive?.content,
          )
        }
      }
    }

  @Test
  @Config(sdk = [29])
  fun `screenshot requests preserve display and default to leaving prototypes visible`() = runTest {
    val messages = recordResults(backgroundScope)
    val host = FakePrototypeHost()
    ReflectionHelpers.setField(
      fixture.service,
      "prototypeController",
      PrototypeController(
        host,
        PrototypeResultSink { _, _, _ -> error("Screenshot must not mutate prototype state") },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      ),
    )
    // API 29 returns the unsupported-capture failure before Dispatchers.IO or the platform API.
    // The real broadcast path still selects the display and enters the host's hide/restore path.
    fixture.actions.requestScreenshot(RequestScreenshot(requestId = null))
    runCurrent()
    var result = resultSince(messages, 0, "screenshot_error")
    assertEquals(0, result["displayId"]?.jsonPrimitive?.int)
    assertEquals(CtrlProxyScreenshotWire.GENERIC_ERROR, result["error"]?.jsonPrimitive?.content)
    assertTrue(host.calls.isEmpty())
    for (displayId in listOf(null, 0, 2)) {
      for (hide in listOf(null, false, true)) {
        val before = messages.size
        val hostCallsBefore = host.calls.size
        if (hide == null)
          fixture.actions.requestScreenshot(
            RequestScreenshot(requestId = null, displayId = displayId),
          )
        else
          fixture.actions.requestScreenshot(
            RequestScreenshot(requestId = null, displayId = displayId, hidePrototypes = hide),
          )
        runCurrent()
        result = resultSince(messages, before, "screenshot_error")
        assertEquals(displayId ?: 0, result["displayId"]?.jsonPrimitive?.int)
        assertEquals(
          CtrlProxyScreenshotWire.GENERIC_ERROR,
          result["error"]?.jsonPrimitive?.content,
        )
        assertEquals(
          if (hide == true) listOf("hideForCapture") else emptyList<String>(),
          host.calls.drop(hostCallsBefore),
        )
        assertFalse(host.captureHidden)
      }
    }
  }

  @Test
  fun `hierarchy request resolves defaults independently and forwards explicit limits and display`() =
    runTest {
      val options = mutableListOf<Pair<Boolean, Triple<Int, Int, Int?>>>()
      ReflectionHelpers.setField(
        fixture.service,
        "hierarchyDebouncer",
        HierarchyDebouncer(
          scope = backgroundScope,
          extractHierarchy = { disableAllFiltering, snapshot ->
            options.add(
              disableAllFiltering to
                Triple(snapshot.maxDepth, snapshot.maxNodes, snapshot.displayId),
            )
            null
          },
        ),
      )
      fixture.actions.requestHierarchy(
        RequestHierarchy(disableAllFiltering = true, requestId = null),
      )
      assertEquals(listOf(true to Triple<Int, Int, Int?>(100, 10_000, null)), options)
      for (maxDepth in listOf(null, 0)) {
        for (maxNodes in listOf(null, 37)) {
          for (displayId in listOf(null, 2)) {
            val before = options.size
            fixture.actions.requestHierarchy(
              RequestHierarchy(
                disableAllFiltering = false,
                maxDepth = maxDepth,
                maxNodes = maxNodes,
                displayId = displayId,
                requestId = null,
              ),
            )
            assertEquals(
              listOf(false to Triple(maxDepth ?: 100, maxNodes ?: 10_000, displayId)),
              options.drop(before),
            )
          }
        }
      }
    }
}
