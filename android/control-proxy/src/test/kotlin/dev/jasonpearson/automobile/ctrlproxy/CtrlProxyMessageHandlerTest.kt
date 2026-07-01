package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.protocol.NetworkMockRuleDto
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Verifies that [CtrlProxyMessageHandler] decodes each wire message into the correct sealed
 * [WebSocketRequest] and dispatches it to the matching action callback with the expected arguments.
 *
 * This is the entire inbound command surface of the on-device runner, so every request type the TS
 * client can send has a case here. The handler is Android-free (it only invokes injected lambdas),
 * so these are fast pure-JVM tests — no Robolectric.
 */
class CtrlProxyMessageHandlerTest {

  private val json = Json {
    classDiscriminator = "type"
    ignoreUnknownKeys = true
  }

  private val calls = mutableListOf<Pair<String, List<Any?>>>()
  private val logs = mutableListOf<String>()

  private fun record(name: String, vararg args: Any?) {
    calls.add(name to args.toList())
  }

  private val lastCall: Pair<String, List<Any?>>
    get() = calls.last()

  private val handler =
      CtrlProxyMessageHandler(
          log = { logs.add(it) },
          onRequestHierarchy = { disableAllFiltering ->
            record("onRequestHierarchy", disableAllFiltering)
          },
          onRequestHierarchyIfStale = { sinceTimestamp ->
            record("onRequestHierarchyIfStale", sinceTimestamp)
          },
          onRequestScreenshot = { requestId -> record("onRequestScreenshot", requestId) },
          onRequestSwipe = { requestId, x1, y1, x2, y2, duration ->
            record("onRequestSwipe", requestId, x1, y1, x2, y2, duration)
          },
          onRequestTapCoordinates = { requestId, x, y, duration ->
            record("onRequestTapCoordinates", requestId, x, y, duration)
          },
          onRequestTwoFingerSwipe = { requestId, x1, y1, x2, y2, duration, offset ->
            record("onRequestTwoFingerSwipe", requestId, x1, y1, x2, y2, duration, offset)
          },
          onRequestDrag = { requestId, x1, y1, x2, y2, press, drag, hold ->
            record("onRequestDrag", requestId, x1, y1, x2, y2, press, drag, hold)
          },
          onRequestPinch = { requestId, cx, cy, dStart, dEnd, rot, duration ->
            record("onRequestPinch", requestId, cx, cy, dStart, dEnd, rot, duration)
          },
          onRequestSetText = { requestId, text, resourceId, dismissKeyboard ->
            record("onRequestSetText", requestId, text, resourceId, dismissKeyboard)
          },
          onRequestImeAction = { requestId, action ->
            record("onRequestImeAction", requestId, action)
          },
          onRequestSelectAll = { requestId -> record("onRequestSelectAll", requestId) },
          onRequestAction = { requestId, action, resourceId ->
            record("onRequestAction", requestId, action, resourceId)
          },
          onRequestClipboard = { requestId, action, text ->
            record("onRequestClipboard", requestId, action, text)
          },
          onRequestInstallCaCert = { requestId, certificate ->
            record("onRequestInstallCaCert", requestId, certificate)
          },
          onRequestRemoveCaCert = { requestId, alias, certificate ->
            record("onRequestRemoveCaCert", requestId, alias, certificate)
          },
          onRequestInstallCaCertFromPath = { requestId, devicePath ->
            record("onRequestInstallCaCertFromPath", requestId, devicePath)
          },
          onRequestGlobalAction = { requestId, action ->
            record("onRequestGlobalAction", requestId, action)
          },
          onRequestDeviceInfo = { requestId -> record("onRequestDeviceInfo", requestId) },
          onGetDeviceOwnerStatus = { requestId -> record("onGetDeviceOwnerStatus", requestId) },
          onGetPermission = { requestId, permission, requestPermission ->
            record("onGetPermission", requestId, permission, requestPermission)
          },
          onSetRecompositionTracking = { enabled ->
            record("onSetRecompositionTracking", enabled)
          },
          onSetAccessibilityFlags = { includeNotImportant, reportViewIds, retrieveInteractive ->
            record(
                "onSetAccessibilityFlags",
                includeNotImportant,
                reportViewIds,
                retrieveInteractive,
            )
          },
          onSetNetworkMockRules = { rulesJson -> record("onSetNetworkMockRules", rulesJson) },
          onSetNetworkErrorSimulation = { enabled, errorType, limit, expiresAt ->
            record("onSetNetworkErrorSimulation", enabled, errorType, limit, expiresAt)
          },
          onGetCurrentFocus = { requestId -> record("onGetCurrentFocus", requestId) },
          onGetTraversalOrder = { requestId -> record("onGetTraversalOrder", requestId) },
          onAddHighlight = { requestId, highlightId, shape ->
            record("onAddHighlight", requestId, highlightId, shape)
          },
          onListPreferenceFiles = { requestId, packageName ->
            record("onListPreferenceFiles", requestId, packageName)
          },
          onGetPreferences = { requestId, packageName, fileName ->
            record("onGetPreferences", requestId, packageName, fileName)
          },
          onSubscribeStorage = { requestId, packageName, fileName ->
            record("onSubscribeStorage", requestId, packageName, fileName)
          },
          onUnsubscribeStorage = { requestId, packageName, fileName ->
            record("onUnsubscribeStorage", requestId, packageName, fileName)
          },
          onGetPreference = { requestId, packageName, fileName, key ->
            record("onGetPreference", requestId, packageName, fileName, key)
          },
          onSetPreference = { requestId, packageName, fileName, key, value, type ->
            record("onSetPreference", requestId, packageName, fileName, key, value, type)
          },
          onRemovePreference = { requestId, packageName, fileName, key ->
            record("onRemovePreference", requestId, packageName, fileName, key)
          },
          onClearPreferences = { requestId, packageName, fileName ->
            record("onClearPreferences", requestId, packageName, fileName)
          },
          onStartRecording = { record("onStartRecording") },
          onStopRecording = { record("onStopRecording") },
          onRequestSettingsGet = { requestId, namespace, key ->
            record("onRequestSettingsGet", requestId, namespace, key)
          },
          onRequestSettingsPut = { requestId, namespace, key, value, valueType ->
            record("onRequestSettingsPut", requestId, namespace, key, value, valueType)
          },
          onRequestSettingsList = { requestId, namespace ->
            record("onRequestSettingsList", requestId, namespace)
          },
          onRequestInstalledPackages = { requestId, includeSystem, userId ->
            record("onRequestInstalledPackages", requestId, includeSystem, userId)
          },
          onRequestPackageInfo = { requestId, packageName, includePermissions ->
            record("onRequestPackageInfo", requestId, packageName, includePermissions)
          },
          onRequestLaunchIntent = { requestId, packageName ->
            record("onRequestLaunchIntent", requestId, packageName)
          },
      )

  private suspend fun dispatch(message: String) {
    handler.handleMessage(json.decodeFromString<WebSocketRequest>(message))
  }

  // ---------------------------------------------------------------------------
  // Hierarchy / screenshot
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches request_hierarchy`() = runTest {
    dispatch("""{"type":"request_hierarchy","requestId":"h1","disableAllFiltering":true}""")
    assertEquals("onRequestHierarchy" to listOf<Any?>(true), lastCall)
  }

  @Test
  fun `dispatches request_hierarchy_if_stale`() = runTest {
    dispatch("""{"type":"request_hierarchy_if_stale","requestId":"h2","sinceTimestamp":12345}""")
    assertEquals("onRequestHierarchyIfStale" to listOf<Any?>(12345L), lastCall)
  }

  @Test
  fun `dispatches request_screenshot`() = runTest {
    dispatch("""{"type":"request_screenshot","requestId":"s1"}""")
    assertEquals("onRequestScreenshot" to listOf<Any?>("s1"), lastCall)
  }

  // ---------------------------------------------------------------------------
  // Gestures
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches request_swipe`() = runTest {
    dispatch(
        """{"type":"request_swipe","requestId":"sw1","x1":0,"y1":100,"x2":0,"y2":500,"duration":400}"""
    )
    assertEquals("onRequestSwipe" to listOf<Any?>("sw1", 0, 100, 0, 500, 400L), lastCall)
  }

  @Test
  fun `dispatches request_tap_coordinates with default duration`() = runTest {
    dispatch("""{"type":"request_tap_coordinates","requestId":"t1","x":100,"y":200}""")
    assertEquals("onRequestTapCoordinates" to listOf<Any?>("t1", 100, 200, 10L), lastCall)
  }

  @Test
  fun `dispatches request_two_finger_swipe`() = runTest {
    dispatch(
        """{"type":"request_two_finger_swipe","requestId":"tf1","x1":0,"y1":0,"x2":10,"y2":20,"duration":300,"offset":50}"""
    )
    assertEquals(
        "onRequestTwoFingerSwipe" to listOf<Any?>("tf1", 0, 0, 10, 20, 300L, 50),
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
        "onRequestDrag" to listOf<Any?>("d1", 50, 50, 150, 150, 800L, 500L, 100L),
        lastCall,
    )
  }

  @Test
  fun `dispatches request_pinch`() = runTest {
    dispatch(
        """{"type":"request_pinch","requestId":"pi1","centerX":540,"centerY":960,"distanceStart":100,"distanceEnd":300,"rotationDegrees":45.0,"duration":500}"""
    )
    assertEquals(
        "onRequestPinch" to listOf<Any?>("pi1", 540, 960, 100, 300, 45.0f, 500L),
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
    assertEquals("onRequestSetText" to listOf<Any?>("txt1", "Hello", "field", true), lastCall)
  }

  @Test
  fun `dispatches request_ime_action`() = runTest {
    dispatch("""{"type":"request_ime_action","requestId":"i1","action":"search"}""")
    assertEquals("onRequestImeAction" to listOf<Any?>("i1", "search"), lastCall)
  }

  @Test
  fun `dispatches request_select_all`() = runTest {
    dispatch("""{"type":"request_select_all","requestId":"sa1"}""")
    assertEquals("onRequestSelectAll" to listOf<Any?>("sa1"), lastCall)
  }

  @Test
  fun `dispatches request_action`() = runTest {
    dispatch(
        """{"type":"request_action","requestId":"a1","action":"long_click","resourceId":"com.app:id/x"}"""
    )
    assertEquals(
        "onRequestAction" to listOf<Any?>("a1", "long_click", "com.app:id/x"),
        lastCall,
    )
  }

  @Test
  fun `dispatches request_clipboard`() = runTest {
    dispatch("""{"type":"request_clipboard","requestId":"c1","action":"copy","text":"hi"}""")
    assertEquals("onRequestClipboard" to listOf<Any?>("c1", "copy", "hi"), lastCall)
  }

  // ---------------------------------------------------------------------------
  // Certificates / permissions / device
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches install_ca_cert`() = runTest {
    dispatch("""{"type":"install_ca_cert","requestId":"cc1","certificate":"PEMDATA"}""")
    assertEquals("onRequestInstallCaCert" to listOf<Any?>("cc1", "PEMDATA"), lastCall)
  }

  @Test
  fun `install_ca_cert with blank certificate is ignored`() = runTest {
    dispatch("""{"type":"install_ca_cert","requestId":"cc2","certificate":""}""")
    assertTrue("no callback should fire", calls.isEmpty())
    assertTrue("a diagnostic should be logged", logs.isNotEmpty())
  }

  @Test
  fun `dispatches install_ca_cert_from_path`() = runTest {
    dispatch(
        """{"type":"install_ca_cert_from_path","requestId":"cp1","devicePath":"/sdcard/cert.pem"}"""
    )
    assertEquals(
        "onRequestInstallCaCertFromPath" to listOf<Any?>("cp1", "/sdcard/cert.pem"),
        lastCall,
    )
  }

  @Test
  fun `dispatches remove_ca_cert with alias only`() = runTest {
    dispatch("""{"type":"remove_ca_cert","requestId":"rc1","alias":"myalias"}""")
    assertEquals("onRequestRemoveCaCert" to listOf<Any?>("rc1", "myalias", null), lastCall)
  }

  @Test
  fun `remove_ca_cert with neither alias nor certificate is ignored`() = runTest {
    dispatch("""{"type":"remove_ca_cert","requestId":"rc2"}""")
    assertTrue(calls.isEmpty())
    assertTrue(logs.isNotEmpty())
  }

  @Test
  fun `dispatches request_global_action`() = runTest {
    dispatch("""{"type":"request_global_action","requestId":"g1","action":"back"}""")
    assertEquals("onRequestGlobalAction" to listOf<Any?>("g1", "back"), lastCall)
  }

  @Test
  fun `dispatches request_device_info`() = runTest {
    dispatch("""{"type":"request_device_info","requestId":"di1"}""")
    assertEquals("onRequestDeviceInfo" to listOf<Any?>("di1"), lastCall)
  }

  @Test
  fun `dispatches get_device_owner_status`() = runTest {
    dispatch("""{"type":"get_device_owner_status","requestId":"do1"}""")
    assertEquals("onGetDeviceOwnerStatus" to listOf<Any?>("do1"), lastCall)
  }

  @Test
  fun `dispatches get_permission`() = runTest {
    dispatch(
        """{"type":"get_permission","requestId":"p1","permission":"android.permission.CAMERA","requestPermission":true}"""
    )
    assertEquals(
        "onGetPermission" to listOf<Any?>("p1", "android.permission.CAMERA", true),
        lastCall,
    )
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches set_recomposition_tracking`() = runTest {
    dispatch("""{"type":"set_recomposition_tracking","requestId":"rt1","enabled":true}""")
    assertEquals("onSetRecompositionTracking" to listOf<Any?>(true), lastCall)
  }

  @Test
  fun `dispatches set_accessibility_flags`() = runTest {
    dispatch(
        """{"type":"set_accessibility_flags","includeNotImportantViews":false,"reportViewIds":true,"retrieveInteractiveWindows":false}"""
    )
    assertEquals(
        "onSetAccessibilityFlags" to listOf<Any?>(false, true, false),
        lastCall,
    )
  }

  @Test
  fun `set_accessibility_flags defaults all flags to true`() = runTest {
    dispatch("""{"type":"set_accessibility_flags"}""")
    assertEquals("onSetAccessibilityFlags" to listOf<Any?>(true, true, true), lastCall)
  }

  @Test
  fun `dispatches set_network_mock_rules re-encoding rules to JSON`() = runTest {
    dispatch(
        """{"type":"set_network_mock_rules","rules":[{"mockId":"m1","host":"example.com","path":"/api","method":"GET","statusCode":200}]}"""
    )
    assertEquals("onSetNetworkMockRules", lastCall.first)
    val rulesJson = lastCall.second[0] as String
    val rules =
        json.decodeFromString(ListSerializer(NetworkMockRuleDto.serializer()), rulesJson)
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
        "onSetNetworkErrorSimulation" to listOf<Any?>(true, "timeout", 5, 99999L),
        lastCall,
    )
  }

  // ---------------------------------------------------------------------------
  // Accessibility focus / highlight
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches get_current_focus`() = runTest {
    dispatch("""{"type":"get_current_focus","requestId":"f1"}""")
    assertEquals("onGetCurrentFocus" to listOf<Any?>("f1"), lastCall)
  }

  @Test
  fun `dispatches get_traversal_order`() = runTest {
    dispatch("""{"type":"get_traversal_order","requestId":"to1"}""")
    assertEquals("onGetTraversalOrder" to listOf<Any?>("to1"), lastCall)
  }

  @Test
  fun `dispatches add_highlight converting the protocol shape to the render model`() = runTest {
    dispatch(
        """{"type":"add_highlight","requestId":"hl1","id":"highlight-1","shape":{"type":"box","bounds":{"x":10,"y":20,"width":100,"height":50}}}"""
    )
    assertEquals("onAddHighlight", lastCall.first)
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
    assertEquals("onListPreferenceFiles" to listOf<Any?>("lf1", "com.example"), lastCall)
  }

  @Test
  fun `dispatches get_preferences`() = runTest {
    dispatch(
        """{"type":"get_preferences","requestId":"gp1","packageName":"com.example","fileName":"settings.xml"}"""
    )
    assertEquals(
        "onGetPreferences" to listOf<Any?>("gp1", "com.example", "settings.xml"),
        lastCall,
    )
  }

  @Test
  fun `dispatches subscribe_storage`() = runTest {
    dispatch(
        """{"type":"subscribe_storage","requestId":"sub1","packageName":"com.example","fileName":"settings.xml"}"""
    )
    assertEquals(
        "onSubscribeStorage" to listOf<Any?>("sub1", "com.example", "settings.xml"),
        lastCall,
    )
  }

  @Test
  fun `unsubscribe_storage with only subscriptionId is a no-op matching the TS wire`() = runTest {
    dispatch(
        """{"type":"unsubscribe_storage","requestId":"unsub1","subscriptionId":"com.example:settings.xml"}"""
    )
    assertTrue("no callback should fire without packageName/fileName", calls.isEmpty())
    assertTrue("a diagnostic should be logged", logs.isNotEmpty())
  }

  @Test
  fun `unsubscribe_storage with packageName and fileName invokes the callback`() = runTest {
    dispatch(
        """{"type":"unsubscribe_storage","requestId":"unsub2","packageName":"com.example","fileName":"settings.xml"}"""
    )
    assertEquals(
        "onUnsubscribeStorage" to listOf<Any?>("unsub2", "com.example", "settings.xml"),
        lastCall,
    )
  }

  @Test
  fun `dispatches get_preference`() = runTest {
    dispatch(
        """{"type":"get_preference","requestId":"gpr1","packageName":"com.example","fileName":"settings.xml","key":"theme"}"""
    )
    assertEquals(
        "onGetPreference" to listOf<Any?>("gpr1", "com.example", "settings.xml", "theme"),
        lastCall,
    )
  }

  @Test
  fun `dispatches set_preference`() = runTest {
    dispatch(
        """{"type":"set_preference","requestId":"spr1","packageName":"com.example","fileName":"settings.xml","key":"theme","value":"dark","valueType":"string"}"""
    )
    assertEquals(
        "onSetPreference" to
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
        "onRemovePreference" to listOf<Any?>("rp1", "com.example", "settings.xml", "theme"),
        lastCall,
    )
  }

  @Test
  fun `dispatches clear_preferences`() = runTest {
    dispatch(
        """{"type":"clear_preferences","requestId":"clp1","packageName":"com.example","fileName":"settings.xml"}"""
    )
    assertEquals(
        "onClearPreferences" to listOf<Any?>("clp1", "com.example", "settings.xml"),
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
    assertEquals(
        "onRequestSettingsGet" to listOf<Any?>("sg1", "system", "user_rotation"),
        lastCall,
    )
  }

  @Test
  fun `dispatches request_settings_put`() = runTest {
    dispatch(
        """{"type":"request_settings_put","requestId":"sp1","namespace":"system","key":"user_rotation","value":"1","valueType":"int"}"""
    )
    assertEquals(
        "onRequestSettingsPut" to listOf<Any?>("sp1", "system", "user_rotation", "1", "int"),
        lastCall,
    )
  }

  @Test
  fun `dispatches request_settings_list`() = runTest {
    dispatch("""{"type":"request_settings_list","requestId":"sl1","namespace":"global"}""")
    assertEquals("onRequestSettingsList" to listOf<Any?>("sl1", "global"), lastCall)
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches start_recording`() = runTest {
    dispatch("""{"type":"start_recording"}""")
    assertEquals("onStartRecording" to emptyList<Any?>(), lastCall)
  }

  @Test
  fun `dispatches stop_recording`() = runTest {
    dispatch("""{"type":"stop_recording"}""")
    assertEquals("onStopRecording" to emptyList<Any?>(), lastCall)
  }

  // ---------------------------------------------------------------------------
  // Package manager
  // ---------------------------------------------------------------------------

  @Test
  fun `dispatches request_installed_packages`() = runTest {
    dispatch(
        """{"type":"request_installed_packages","requestId":"ip1","includeSystem":false,"userId":10}"""
    )
    assertEquals(
        "onRequestInstalledPackages" to listOf<Any?>("ip1", false, 10),
        lastCall,
    )
  }

  @Test
  fun `dispatches request_package_info`() = runTest {
    dispatch(
        """{"type":"request_package_info","requestId":"pin1","packageName":"com.example","includePermissions":true}"""
    )
    assertEquals(
        "onRequestPackageInfo" to listOf<Any?>("pin1", "com.example", true),
        lastCall,
    )
  }

  @Test
  fun `dispatches request_launch_intent`() = runTest {
    dispatch("""{"type":"request_launch_intent","requestId":"li1","packageName":"com.example"}""")
    assertEquals("onRequestLaunchIntent" to listOf<Any?>("li1", "com.example"), lastCall)
  }

  // ---------------------------------------------------------------------------
  // Ahead-of-need: request_hit_test decodes but has no wired device handler
  // ---------------------------------------------------------------------------

  @Test
  fun `request_hit_test is decoded but not dispatched to any callback`() = runTest {
    dispatch("""{"type":"request_hit_test","requestId":"ht1","x":320,"y":720}""")
    assertTrue("no callback should fire for the ahead-of-need type", calls.isEmpty())
    assertTrue("the unhandled request should be logged", logs.isNotEmpty())
  }

  @Test
  fun `handleMessage returns null for fire-and-forget commands`() = runTest {
    val response =
        handler.handleMessage(
            json.decodeFromString<WebSocketRequest>(
                """{"type":"request_screenshot","requestId":"s1"}"""
            )
        )
    assertEquals(null, response)
  }
}
