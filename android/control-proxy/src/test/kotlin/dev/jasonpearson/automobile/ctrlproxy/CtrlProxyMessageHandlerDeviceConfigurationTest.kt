package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import dev.jasonpearson.automobile.protocol.NetworkMockRuleDto
import dev.jasonpearson.automobile.protocol.RequestGlobalAction
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.builtins.ListSerializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class CtrlProxyMessageHandlerDeviceConfigurationTest : CtrlProxyMessageHandlerFixtures() {
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
}
