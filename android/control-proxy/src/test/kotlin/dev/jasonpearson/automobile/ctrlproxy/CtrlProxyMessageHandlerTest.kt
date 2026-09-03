package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.protocol.DragResult
import dev.jasonpearson.automobile.protocol.NetworkMockRuleDto
import dev.jasonpearson.automobile.protocol.PinchResult
import dev.jasonpearson.automobile.protocol.RequestDrag
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
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

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

  private val json = Json {
    classDiscriminator = "type"
    ignoreUnknownKeys = true
  }

  private val actions = RecordingCtrlProxyActions()
  private val logs = mutableListOf<String>()
  private val handler = CtrlProxyMessageHandler(actions, log = { logs.add(it) })

  private val calls: List<Pair<String, List<Any?>>>
    get() = actions.calls

  private val lastCall: Pair<String, List<Any?>>
    get() = actions.calls.last()

  private suspend fun dispatch(message: String) {
    handler.handleMessage(json.decodeFromString<WebSocketRequest>(message))
  }

  /** Dispatch and return the synchronous response (non-null only for the guard/error paths). */
  private suspend fun dispatchForResponse(message: String): WebSocketResponse? =
    handler.handleMessage(json.decodeFromString<WebSocketRequest>(message))

  // ---------------------------------------------------------------------------
  // Hierarchy / screenshot
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches request_hierarchy`() = runTest {
    dispatch("""{"type":"request_hierarchy","requestId":"h1","disableAllFiltering":true}""")
    assertEquals("requestHierarchy" to listOf<Any?>(true), lastCall)
  }

  @Test
  fun `dispatches request_hierarchy_if_stale`() = runTest {
    dispatch("""{"type":"request_hierarchy_if_stale","requestId":"h2","sinceTimestamp":12345}""")
    assertEquals("requestHierarchyIfStale" to listOf<Any?>(12345L), lastCall)
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
    assertEquals("requestScreenshot" to listOf<Any?>("s1"), lastCall)
  }

  // ---------------------------------------------------------------------------
  // Gestures
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches request_swipe`() = runTest {
    dispatch(
      """{"type":"request_swipe","requestId":"sw1","x1":0,"y1":100,"x2":0,"y2":500,"duration":400}"""
    )
    // Coordinates dispatch as Double (#2927); integer JSON decodes to identical .0 values.
    assertEquals("requestSwipe" to listOf<Any?>("sw1", 0.0, 100.0, 0.0, 500.0, 400L), lastCall)
  }

  @Test
  fun `dispatches request_tap_coordinates with default duration`() = runTest {
    dispatch("""{"type":"request_tap_coordinates","requestId":"t1","x":100,"y":200}""")
    assertEquals("requestTapCoordinates" to listOf<Any?>("t1", 100.0, 200.0, 10L), lastCall)
  }

  @Test
  fun `dispatches request_two_finger_swipe`() = runTest {
    dispatch(
      """{"type":"request_two_finger_swipe","requestId":"tf1","x1":0,"y1":0,"x2":10,"y2":20,"duration":300,"offset":50}"""
    )
    // offset stays Int (pixel offset, not a coordinate).
    assertEquals(
      "requestTwoFingerSwipe" to listOf<Any?>("tf1", 0.0, 0.0, 10.0, 20.0, 300L, 50),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_drag resolving legacy holdTime and duration`() = runTest {
    dispatch(
      """{"type":"request_drag","requestId":"d1","x1":50,"y1":50,"x2":150,"y2":150,"holdTime":800,"duration":500}"""
    )
    // holdTime resolves press duration, duration resolves drag duration, hold defaults to 100.
    assertEquals(
      "requestDrag" to listOf<Any?>("d1", 50.0, 50.0, 150.0, 150.0, 800L, 500L, 100L),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_pinch`() = runTest {
    dispatch(
      """{"type":"request_pinch","requestId":"pi1","centerX":540,"centerY":960,"distanceStart":100,"distanceEnd":300,"rotationDegrees":45.0,"duration":500}"""
    )
    assertEquals(
      "requestPinch" to listOf<Any?>("pi1", 540.0, 960.0, 100.0, 300.0, 45.0f, 500L),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_pinch preserving fractional coordinates`() = runTest {
    // #2927: a fractional center/distance survives decode and reaches the action as Double,
    // not truncated to Int.
    dispatch(
      """{"type":"request_pinch","requestId":"pi-frac","centerX":100.5,"centerY":200.25,"distanceStart":80.5,"distanceEnd":120.75,"rotationDegrees":45.0,"duration":500}"""
    )
    assertEquals(
      "requestPinch" to listOf<Any?>("pi-frac", 100.5, 200.25, 80.5, 120.75, 45.0f, 500L),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_swipe preserving fractional coordinates`() = runTest {
    dispatch(
      """{"type":"request_swipe","requestId":"sw-frac","x1":0.5,"y1":100.25,"x2":10.75,"y2":500.125,"duration":400}"""
    )
    assertEquals(
      "requestSwipe" to listOf<Any?>("sw-frac", 0.5, 100.25, 10.75, 500.125, 400L),
      lastCall,
    )
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
  fun `rejects swipe with positive-infinity coordinate`() = runTest {
    val response =
      handler.handleMessage(
        RequestSwipe(requestId = "s", x1 = 0.0, y1 = 0.0, x2 = Double.POSITIVE_INFINITY, y2 = 500.0)
      )
    assertGuarded(response, "x2")
    assertTrue(response is SwipeResult)
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
        )
      )
    assertGuarded(response, "y1")
    assertTrue(response is SwipeResult)
  }

  @Test
  fun `rejects drag with NaN coordinate`() = runTest {
    val response =
      handler.handleMessage(
        RequestDrag(requestId = "d", x1 = 50.0, y1 = 50.0, x2 = 150.0, y2 = Double.NaN)
      )
    assertGuarded(response, "y2")
    assertTrue(response is DragResult)
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
        )
      )
    assertGuarded(response, "centerX")
    assertTrue(response is PinchResult)
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
        )
      )
    assertGuarded(response, "rotationDegrees")
    assertTrue(response is PinchResult)
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
          """{"type":"request_tap_coordinates","requestId":"t","x":1e309,"y":200}"""
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
        """{"type":"request_swipe","requestId":"ok","x1":-0.5,"y1":100.25,"x2":10.75,"y2":500.125,"duration":400}"""
      )
    assertNull("finite coordinates must not be guarded", response)
    assertEquals(
      "requestSwipe" to listOf<Any?>("ok", -0.5, 100.25, 10.75, 500.125, 400L),
      lastCall,
    )
  }

  @Test
  fun `finite pinch with rotationDegrees still dispatches`() = runTest {
    val response =
      dispatchForResponse(
        """{"type":"request_pinch","requestId":"okp","centerX":540,"centerY":960,"distanceStart":100,"distanceEnd":300,"rotationDegrees":45.0,"duration":500}"""
      )
    assertNull(response)
    assertEquals(
      "requestPinch" to listOf<Any?>("okp", 540.0, 960.0, 100.0, 300.0, 45.0f, 500L),
      lastCall,
    )
  }

  // A huge but finite two-finger `offset` (Int, cannot be non-finite) is unaffected by the guard.
  @Test
  fun `large finite two-finger offset still dispatches`() = runTest {
    val response =
      dispatchForResponse(
        """{"type":"request_two_finger_swipe","requestId":"tfo","x1":0,"y1":0,"x2":10,"y2":20,"duration":300,"offset":100000}"""
      )
    assertNull(response)
    assertEquals(
      "requestTwoFingerSwipe" to listOf<Any?>("tfo", 0.0, 0.0, 10.0, 20.0, 300L, 100000),
      lastCall,
    )
  }

  // ---------------------------------------------------------------------------
  // Text input / actions
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches request_set_text`() = runTest {
    dispatch(
      """{"type":"request_set_text","requestId":"txt1","text":"Hello","resourceId":"field","dismissKeyboard":true}"""
    )
    assertEquals("requestSetText" to listOf<Any?>("txt1", "Hello", "field", true), lastCall)
  }

  @Test
  fun `forwards frame context with request_set_text`() = runTest {
    dispatch(
      """{"type":"request_set_text","requestId":"txt1","text":"Hello","frameContext":"frame-1"}"""
    )
    assertEquals(
      "requestSetText" to listOf<Any?>("txt1", "Hello", null, false, "frame-1"),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_insert_text`() = runTest {
    dispatch("""{"type":"request_insert_text","requestId":"txt2","text":" world"}""")
    assertEquals("requestInsertText" to listOf<Any?>("txt2", " world"), lastCall)
  }

  @Test
  fun `dispatches request_ime_action`() = runTest {
    dispatch("""{"type":"request_ime_action","requestId":"i1","action":"search"}""")
    assertEquals("requestImeAction" to listOf<Any?>("i1", "search"), lastCall)
  }

  @Test
  fun `forwards frame context with request_ime_action`() = runTest {
    dispatch(
      """{"type":"request_ime_action","requestId":"i1","action":"search","frameContext":"frame-1"}"""
    )
    assertEquals("requestImeAction" to listOf<Any?>("i1", "search", "frame-1"), lastCall)
  }

  @Test
  fun `dispatches request_select_all`() = runTest {
    dispatch("""{"type":"request_select_all","requestId":"sa1"}""")
    assertEquals("requestSelectAll" to listOf<Any?>("sa1"), lastCall)
  }

  @Test
  fun `dispatches request_action`() = runTest {
    dispatch(
      """{"type":"request_action","requestId":"a1","action":"long_click","resourceId":"com.app:id/x"}"""
    )
    assertEquals(
      "requestAction" to listOf<Any?>("a1", "long_click", "com.app:id/x", null),
      lastCall,
    )
  }

  @Test
  fun `dispatches request_action selector`() = runTest {
    dispatch(
      """{"type":"request_action","requestId":"a2","action":"long_click","selector":{"testTag":"message_row_42","collectionRow":4,"collectionColumn":0}}"""
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
      """{"type":"install_ca_cert_from_path","requestId":"cp1","devicePath":"/sdcard/cert.pem"}"""
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
      """{"type":"remove_ca_cert","requestId":"rc4","alias":"myalias","certificate":"cert-pem"}"""
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
    assertEquals("requestGlobalAction" to listOf<Any?>("g1", "back"), lastCall)
  }

  @Test
  fun `dispatches validate_frame_context`() = runTest {
    dispatch(
      """{"type":"validate_frame_context","requestId":"context-1","frameContext":"epoch:4"}"""
    )
    assertEquals("validateFrameContext" to listOf<Any?>("context-1", "epoch:4"), lastCall)
  }

  @Test
  fun `forwards frame context with request_global_action`() = runTest {
    dispatch(
      """{"type":"request_global_action","requestId":"g1","action":"back","frameContext":"frame-1"}"""
    )
    assertEquals("requestGlobalAction" to listOf<Any?>("g1", "back", "frame-1"), lastCall)
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
      """{"type":"get_permission","requestId":"p1","permission":"android.permission.CAMERA","requestPermission":true}"""
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
      """{"type":"set_accessibility_flags","includeNotImportantViews":false,"reportViewIds":true,"retrieveInteractiveWindows":false,"occlusionEnabled":false}"""
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
      """{"type":"set_network_mock_rules","rules":[{"mockId":"m1","host":"example.com","path":"/api","method":"GET","statusCode":200}]}"""
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
  fun `dispatches set_network_error_simulation`() = runTest {
    dispatch(
      """{"type":"set_network_error_simulation","enabled":true,"errorType":"timeout","limit":5,"expiresAtEpochMs":99999}"""
    )
    assertEquals(
      "setNetworkErrorSimulation" to listOf<Any?>(true, "timeout", 5, 99999L),
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
      """{"type":"add_highlight","requestId":"hl1","id":"highlight-1","shape":{"type":"box","bounds":{"x":10,"y":20,"width":100,"height":50}}}"""
    )
    assertEquals("addHighlight", lastCall.first)
    assertEquals("hl1", lastCall.second[0])
    assertEquals("highlight-1", lastCall.second[1])
    val shape = lastCall.second[2] as HighlightShape
    assertEquals("box", shape.type)
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
      """{"type":"get_preferences","requestId":"gp1","packageName":"com.example","fileName":"settings.xml"}"""
    )
    assertEquals("getPreferences" to listOf<Any?>("gp1", "com.example", "settings.xml"), lastCall)
  }

  @Test
  fun `dispatches list_data_stores`() = runTest {
    dispatch(
      """{"type":"list_data_stores","requestId":"lds1","packageName":"com.example","adapterName":"settings"}"""
    )
    assertEquals("listDataStores" to listOf<Any?>("lds1", "com.example", "settings"), lastCall)
  }

  @Test
  fun `dispatches get_data_store`() = runTest {
    dispatch(
      """{"type":"get_data_store","requestId":"gds1","packageName":"com.example","adapterName":"settings","storeName":"user_prefs"}"""
    )
    assertEquals(
      "getDataStore" to listOf<Any?>("gds1", "com.example", "settings", "user_prefs"),
      lastCall,
    )
  }

  @Test
  fun `dispatches subscribe_storage`() = runTest {
    dispatch(
      """{"type":"subscribe_storage","requestId":"sub1","packageName":"com.example","fileName":"settings.xml"}"""
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
      """{"type":"unsubscribe_storage","requestId":"unsub1","subscriptionId":"com.example:settings.xml"}"""
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
      """{"type":"unsubscribe_storage","requestId":"unsub3","subscriptionId":"com.example:weird:name.xml"}"""
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
      """{"type":"unsubscribe_storage","requestId":"unsub5","subscriptionId":":settings.xml"}"""
    )
    dispatch(
      """{"type":"unsubscribe_storage","requestId":"unsub6","subscriptionId":"com.example:"}"""
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
        """{"type":"unsubscribe_storage","requestId":"unsub7","subscriptionId":"other.pkg:other.xml","packageName":"com.example","fileName":"settings.xml"}"""
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
      """{"type":"unsubscribe_storage","requestId":"unsub2","packageName":"com.example","fileName":"settings.xml"}"""
    )
    assertEquals(
      "unsubscribeStorage" to listOf<Any?>("unsub2", "com.example", "settings.xml"),
      lastCall,
    )
  }

  @Test
  fun `dispatches get_preference`() = runTest {
    dispatch(
      """{"type":"get_preference","requestId":"gpr1","packageName":"com.example","fileName":"settings.xml","key":"theme"}"""
    )
    assertEquals(
      "getPreference" to listOf<Any?>("gpr1", "com.example", "settings.xml", "theme"),
      lastCall,
    )
  }

  @Test
  fun `dispatches set_preference`() = runTest {
    dispatch(
      """{"type":"set_preference","requestId":"spr1","packageName":"com.example","fileName":"settings.xml","key":"theme","value":"dark","valueType":"string"}"""
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
      """{"type":"remove_preference","requestId":"rp1","packageName":"com.example","fileName":"settings.xml","key":"theme"}"""
    )
    assertEquals(
      "removePreference" to listOf<Any?>("rp1", "com.example", "settings.xml", "theme"),
      lastCall,
    )
  }

  @Test
  fun `dispatches clear_preferences`() = runTest {
    dispatch(
      """{"type":"clear_preferences","requestId":"clp1","packageName":"com.example","fileName":"settings.xml"}"""
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
      """{"type":"request_settings_get","requestId":"sg1","namespace":"system","key":"user_rotation"}"""
    )
    assertEquals("requestSettingsGet" to listOf<Any?>("sg1", "system", "user_rotation"), lastCall)
  }

  @Test
  fun `dispatches request_settings_put`() = runTest {
    dispatch(
      """{"type":"request_settings_put","requestId":"sp1","namespace":"system","key":"user_rotation","value":"1","valueType":"int"}"""
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
  fun `dispatches start_recording`() = runTest {
    dispatch("""{"type":"start_recording"}""")
    assertEquals("startRecording" to emptyList<Any?>(), lastCall)
  }

  @Test
  fun `dispatches stop_recording`() = runTest {
    dispatch("""{"type":"stop_recording"}""")
    assertEquals("stopRecording" to emptyList<Any?>(), lastCall)
  }

  // ---------------------------------------------------------------------------
  // Package manager
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches request_installed_packages`() = runTest {
    dispatch(
      """{"type":"request_installed_packages","requestId":"ip1","includeSystem":false,"userId":10}"""
    )
    assertEquals("requestInstalledPackages" to listOf<Any?>("ip1", false, 10), lastCall)
  }

  @Test
  fun `dispatches request_package_info`() = runTest {
    dispatch(
      """{"type":"request_package_info","requestId":"pin1","packageName":"com.example","includePermissions":true}"""
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
        """{"type":"add_highlight","requestId":"h1","id":"x","shape":{"type":"box","bounds":{"x":0,"y":0,"width":1,"height":1}}}""",
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
        """{"type":"add_highlight","requestId":"h1","id":"x","shape":{"type":"box","bounds":{"x":0,"y":0,"width":1,"height":1}}}""",
        """{"type":"set_network_mock_rules","rules":[]}""",
        """{"type":"start_recording"}""",
      )
    for (message in messages) {
      val response = noOpHandler.handleMessage(json.decodeFromString<WebSocketRequest>(message))
      assertEquals(null, response)
    }
    assertTrue("recording fake must be untouched by the no-op handler", calls.isEmpty())
  }
}
