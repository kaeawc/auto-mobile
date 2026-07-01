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
    assertEquals("requestSwipe" to listOf<Any?>("sw1", 0, 100, 0, 500, 400L), lastCall)
  }

  @Test
  fun `dispatches request_tap_coordinates with default duration`() = runTest {
    dispatch("""{"type":"request_tap_coordinates","requestId":"t1","x":100,"y":200}""")
    assertEquals("requestTapCoordinates" to listOf<Any?>("t1", 100, 200, 10L), lastCall)
  }

  @Test
  fun `dispatches request_two_finger_swipe`() = runTest {
    dispatch(
        """{"type":"request_two_finger_swipe","requestId":"tf1","x1":0,"y1":0,"x2":10,"y2":20,"duration":300,"offset":50}"""
    )
    assertEquals(
        "requestTwoFingerSwipe" to listOf<Any?>("tf1", 0, 0, 10, 20, 300L, 50),
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
        "requestDrag" to listOf<Any?>("d1", 50, 50, 150, 150, 800L, 500L, 100L),
        lastCall,
    )
  }

  @Test
  fun `dispatches request_pinch`() = runTest {
    dispatch(
        """{"type":"request_pinch","requestId":"pi1","centerX":540,"centerY":960,"distanceStart":100,"distanceEnd":300,"rotationDegrees":45.0,"duration":500}"""
    )
    assertEquals(
        "requestPinch" to listOf<Any?>("pi1", 540, 960, 100, 300, 45.0f, 500L),
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
  fun `dispatches request_ime_action`() = runTest {
    dispatch("""{"type":"request_ime_action","requestId":"i1","action":"search"}""")
    assertEquals("requestImeAction" to listOf<Any?>("i1", "search"), lastCall)
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
    assertEquals("requestAction" to listOf<Any?>("a1", "long_click", "com.app:id/x"), lastCall)
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
        """{"type":"set_accessibility_flags","includeNotImportantViews":false,"reportViewIds":true,"retrieveInteractiveWindows":false}"""
    )
    assertEquals("setAccessibilityFlags" to listOf<Any?>(false, true, false), lastCall)
  }

  @Test
  fun `set_accessibility_flags defaults all flags to true`() = runTest {
    dispatch("""{"type":"set_accessibility_flags"}""")
    assertEquals("setAccessibilityFlags" to listOf<Any?>(true, true, true), lastCall)
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
    // Real TS traffic sends only the subscriptionId ("packageName:fileName"). The handler must split
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
    // subscriptionId = "packageName:fileName"; a file name may itself contain ':', so only the first
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
