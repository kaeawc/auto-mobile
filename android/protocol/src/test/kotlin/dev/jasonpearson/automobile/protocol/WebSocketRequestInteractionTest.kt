package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlin.test.assertIs
import org.junit.jupiter.api.Test

class WebSocketRequestInteractionTest : WebSocketRequestTestSupport() {
  @Test
  fun `deserialize request_clipboard`() {
    val message =
      """{"type":"request_clipboard","requestId":"clip-1","action":"copy","text":"Copied text"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestClipboard>(request)
    assertEquals("clip-1", request.requestId)
    assertEquals("copy", request.action)
    assertEquals("Copied text", request.text)
  }

  @Test
  fun `deserialize add_highlight`() {
    val message =
      """{"type":"add_highlight","requestId":"hl-1","id":"highlight-1","shape":{"type":"box","bounds":{"x":0,"y":0,"width":100,"height":50}}}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<AddHighlight>(request)
    assertEquals("hl-1", request.requestId)
    assertEquals("highlight-1", request.id)
    assertEquals("box", request.shape?.type)
    assertEquals(100, request.shape?.bounds?.width)
    assertEquals(50, request.shape?.bounds?.height)
  }

  @Test
  fun `deserialize request_action with bounds disambiguation`() {
    val message =
      """{"type":"request_action","requestId":"a1","action":"click","resourceId":"com.app:id/name","boundsLeft":10,"boundsTop":20,"boundsRight":100,"boundsBottom":80}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestAction>(request)
    assertEquals("a1", request.requestId)
    assertEquals("click", request.action)
    assertEquals("com.app:id/name", request.resourceId)
    assertEquals(10, request.boundsLeft)
    assertEquals(20, request.boundsTop)
    assertEquals(100, request.boundsRight)
    assertEquals(80, request.boundsBottom)
  }

  @Test
  fun `deserialize request_action bounds only with null resourceId`() {
    val message =
      """{"type":"request_action","requestId":"b2","action":"click","resourceId":null,"boundsLeft":10,"boundsTop":20,"boundsRight":100,"boundsBottom":80}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestAction>(request)
    assertEquals("b2", request.requestId)
    assertEquals("click", request.action)
    assertEquals(null, request.resourceId)
    assertEquals(10, request.boundsLeft)
    assertEquals(20, request.boundsTop)
    assertEquals(100, request.boundsRight)
    assertEquals(80, request.boundsBottom)
  }

  @Test
  fun `deserialize request_action with stable selector`() {
    val message =
      """{"type":"request_action","requestId":"selector-1","action":"long_click","selector":{"testTag":"message_row_42","uniqueId":"android-node-7","collectionRow":4,"collectionColumn":0}}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestAction>(request)
    assertEquals("message_row_42", request.selector?.testTag)
    assertEquals("android-node-7", request.selector?.uniqueId)
    assertEquals(4, request.selector?.collectionRow)
    assertEquals(0, request.selector?.collectionColumn)
  }

  @Test
  fun `deserialize request_hit_test`() {
    val message = """{"type":"request_hit_test","requestId":"ht-1","x":320,"y":720}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestHitTest>(request)
    assertEquals("ht-1", request.requestId)
    assertEquals(320, request.x)
    assertEquals(720, request.y)
  }

  @Test
  fun `deserialize get_preferences`() {
    val message =
      """{"type":"get_preferences","requestId":"pref-1","packageName":"com.example.app","fileName":"settings.xml"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<GetPreferences>(request)
    assertEquals("pref-1", request.requestId)
    assertEquals("com.example.app", request.packageName)
    assertEquals("settings.xml", request.fileName)
  }

  @Test
  fun `deserialize list_data_stores`() {
    val message =
      """{"type":"list_data_stores","requestId":"lds-1","packageName":"com.example.app","adapterName":"settings"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<ListDataStores>(request)
    assertEquals("lds-1", request.requestId)
    assertEquals("com.example.app", request.packageName)
    assertEquals("settings", request.adapterName)
  }

  @Test
  fun `deserialize get_data_store`() {
    val message =
      """{"type":"get_data_store","requestId":"gds-1","packageName":"com.example.app","adapterName":"settings","storeName":"user_prefs"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<GetDataStore>(request)
    assertEquals("gds-1", request.requestId)
    assertEquals("com.example.app", request.packageName)
    assertEquals("settings", request.adapterName)
    assertEquals("user_prefs", request.storeName)
  }

  @Test
  fun `deserialize request_settings_get`() {
    val message =
      """{"type":"request_settings_get","requestId":"sg-1","namespace":"system","key":"user_rotation"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestSettingsGet>(request)
    assertEquals("sg-1", request.requestId)
    assertEquals("system", request.namespace)
    assertEquals("user_rotation", request.key)
  }

  @Test
  fun `deserialize request_settings_put with int value`() {
    val message =
      """{"type":"request_settings_put","requestId":"sp-1","namespace":"system","key":"user_rotation","value":"1","valueType":"int"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestSettingsPut>(request)
    assertEquals("sp-1", request.requestId)
    assertEquals("system", request.namespace)
    assertEquals("user_rotation", request.key)
    assertEquals("1", request.value)
    assertEquals("int", request.valueType)
  }

  @Test
  fun `deserialize request_settings_put with null value defaults to string type`() {
    val message =
      """{"type":"request_settings_put","requestId":"sp-2","namespace":"secure","key":"enabled_accessibility_services","value":null}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestSettingsPut>(request)
    assertEquals("sp-2", request.requestId)
    assertEquals("secure", request.namespace)
    assertEquals("enabled_accessibility_services", request.key)
    assertEquals(null, request.value)
    assertEquals("string", request.valueType)
  }

  @Test
  fun `deserialize request_settings_list`() {
    val message = """{"type":"request_settings_list","requestId":"sl-1","namespace":"global"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestSettingsList>(request)
    assertEquals("sl-1", request.requestId)
    assertEquals("global", request.namespace)
  }

  @Test
  fun `deserialize request_installed_packages`() {
    val message =
      """{"type":"request_installed_packages","requestId":"pkg-1","includeSystem":false,"userId":10}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestInstalledPackages>(request)
    assertEquals("pkg-1", request.requestId)
    assertEquals(false, request.includeSystem)
    assertEquals(10, request.userId)
  }

  @Test
  fun `deserialize request_installed_packages with defaults`() {
    val message = """{"type":"request_installed_packages","requestId":"pkg-2"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestInstalledPackages>(request)
    assertEquals("pkg-2", request.requestId)
    assertEquals(true, request.includeSystem)
    assertEquals(null, request.userId)
  }

  @Test
  fun `deserialize request_package_info`() {
    val message =
      """{"type":"request_package_info","requestId":"pi-1","packageName":"com.example.app","includePermissions":true}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestPackageInfo>(request)
    assertEquals("pi-1", request.requestId)
    assertEquals("com.example.app", request.packageName)
    assertEquals(true, request.includePermissions)
  }

  @Test
  fun `deserialize request_launch_intent`() {
    val message =
      """{"type":"request_launch_intent","requestId":"li-1","packageName":"com.example.app"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestLaunchIntent>(request)
    assertEquals("li-1", request.requestId)
    assertEquals("com.example.app", request.packageName)
  }

  @Test
  fun `deserialize set_accessibility_flags`() {
    val message =
      """{"type":"set_accessibility_flags","includeNotImportantViews":false,"reportViewIds":true,"retrieveInteractiveWindows":false,"occlusionEnabled":false}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<SetAccessibilityFlags>(request)
    assertEquals(null, request.requestId)
    assertEquals(false, request.includeNotImportantViews)
    assertEquals(true, request.reportViewIds)
    assertEquals(false, request.retrieveInteractiveWindows)
    assertEquals(false, request.occlusionEnabled)
  }

  @Test
  fun `deserialize set_accessibility_flags defaults to true`() {
    val message = """{"type":"set_accessibility_flags"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<SetAccessibilityFlags>(request)
    assertEquals(true, request.includeNotImportantViews)
    assertEquals(true, request.reportViewIds)
    assertEquals(true, request.retrieveInteractiveWindows)
    assertEquals(true, request.occlusionEnabled)
  }

  @Test
  fun `deserialize start_recording`() {
    val message = """{"type":"start_recording"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<StartRecording>(request)
    assertEquals(null, request.requestId)
  }

  @Test
  fun `deserialize stop_recording`() {
    val message = """{"type":"stop_recording"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<StopRecording>(request)
    assertEquals(null, request.requestId)
  }
}
