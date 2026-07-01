package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class WebSocketRequestTest {
  private val json = Json {
    classDiscriminator = "type"
    ignoreUnknownKeys = true
  }

  @Test
  fun `deserialize request_hierarchy`() {
    val message = """{"type":"request_hierarchy","requestId":"test-1"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestHierarchy>(request)
    assertEquals("test-1", request.requestId)
    assertEquals(false, request.disableAllFiltering)
  }

  @Test
  fun `deserialize request_hierarchy with filtering disabled`() {
    val message = """{"type":"request_hierarchy","requestId":"test-2","disableAllFiltering":true}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestHierarchy>(request)
    assertEquals("test-2", request.requestId)
    assertEquals(true, request.disableAllFiltering)
  }

  @Test
  fun `deserialize request_tap_coordinates`() {
    val message = """{"type":"request_tap_coordinates","requestId":"tap-1","x":100,"y":200}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestTapCoordinates>(request)
    assertEquals("tap-1", request.requestId)
    assertEquals(100, request.x)
    assertEquals(200, request.y)
    assertEquals(10L, request.duration) // default
  }

  @Test
  fun `deserialize request_swipe`() {
    val message = """{"type":"request_swipe","requestId":"swipe-1","x1":0,"y1":100,"x2":0,"y2":500,"duration":400}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestSwipe>(request)
    assertEquals("swipe-1", request.requestId)
    assertEquals(0, request.x1)
    assertEquals(100, request.y1)
    assertEquals(0, request.x2)
    assertEquals(500, request.y2)
    assertEquals(400L, request.duration)
  }

  @Test
  fun `deserialize request_drag with legacy fields`() {
    val message = """{"type":"request_drag","requestId":"drag-1","x1":50,"y1":50,"x2":150,"y2":150,"holdTime":800,"duration":500}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestDrag>(request)
    assertEquals("drag-1", request.requestId)
    assertEquals(50, request.x1)
    assertEquals(50, request.y1)
    assertEquals(150, request.x2)
    assertEquals(150, request.y2)
    // Legacy fields are used as fallback
    assertEquals(800L, request.resolvedPressDurationMs)
    assertEquals(500L, request.resolvedDragDurationMs)
  }

  @Test
  fun `deserialize request_pinch`() {
    val message = """{"type":"request_pinch","requestId":"pinch-1","centerX":540,"centerY":960,"distanceStart":100,"distanceEnd":300,"rotationDegrees":45.0,"duration":500}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestPinch>(request)
    assertEquals("pinch-1", request.requestId)
    assertEquals(540, request.centerX)
    assertEquals(960, request.centerY)
    assertEquals(100, request.distanceStart)
    assertEquals(300, request.distanceEnd)
    assertEquals(45.0f, request.rotationDegrees)
    assertEquals(500L, request.duration)
  }

  @Test
  fun `deserialize request_set_text`() {
    val message = """{"type":"request_set_text","requestId":"text-1","text":"Hello World","resourceId":"input_field"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestSetText>(request)
    assertEquals("text-1", request.requestId)
    assertEquals("Hello World", request.text)
    assertEquals("input_field", request.resourceId)
  }

  @Test
  fun `deserialize request_ime_action`() {
    val message = """{"type":"request_ime_action","requestId":"ime-1","action":"search"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestImeAction>(request)
    assertEquals("ime-1", request.requestId)
    assertEquals("search", request.action)
  }

  @Test
  fun `deserialize request_clipboard`() {
    val message = """{"type":"request_clipboard","requestId":"clip-1","action":"copy","text":"Copied text"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestClipboard>(request)
    assertEquals("clip-1", request.requestId)
    assertEquals("copy", request.action)
    assertEquals("Copied text", request.text)
  }

  @Test
  fun `deserialize add_highlight`() {
    val message = """{"type":"add_highlight","requestId":"hl-1","id":"highlight-1","shape":{"type":"box","bounds":{"x":0,"y":0,"width":100,"height":50}}}"""
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
    val message = """{"type":"get_preferences","requestId":"pref-1","packageName":"com.example.app","fileName":"settings.xml"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<GetPreferences>(request)
    assertEquals("pref-1", request.requestId)
    assertEquals("com.example.app", request.packageName)
    assertEquals("settings.xml", request.fileName)
  }

  @Test
  fun `deserialize request_settings_get`() {
    val message = """{"type":"request_settings_get","requestId":"sg-1","namespace":"system","key":"user_rotation"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestSettingsGet>(request)
    assertEquals("sg-1", request.requestId)
    assertEquals("system", request.namespace)
    assertEquals("user_rotation", request.key)
  }

  @Test
  fun `deserialize request_settings_put with int value`() {
    val message = """{"type":"request_settings_put","requestId":"sp-1","namespace":"system","key":"user_rotation","value":"1","valueType":"int"}"""
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
    val message = """{"type":"request_settings_put","requestId":"sp-2","namespace":"secure","key":"enabled_accessibility_services","value":null}"""
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
        """{"type":"set_accessibility_flags","includeNotImportantViews":false,"reportViewIds":true,"retrieveInteractiveWindows":false}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<SetAccessibilityFlags>(request)
    assertEquals(null, request.requestId)
    assertEquals(false, request.includeNotImportantViews)
    assertEquals(true, request.reportViewIds)
    assertEquals(false, request.retrieveInteractiveWindows)
  }

  @Test
  fun `deserialize set_accessibility_flags defaults to true`() {
    val message = """{"type":"set_accessibility_flags"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<SetAccessibilityFlags>(request)
    assertEquals(true, request.includeNotImportantViews)
    assertEquals(true, request.reportViewIds)
    assertEquals(true, request.retrieveInteractiveWindows)
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

  @Test
  fun `deserialize subscribe_storage`() {
    val message =
        """{"type":"subscribe_storage","requestId":"sub-1","packageName":"com.example.app","fileName":"settings.xml"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<SubscribeStorage>(request)
    assertEquals("sub-1", request.requestId)
    assertEquals("com.example.app", request.packageName)
    assertEquals("settings.xml", request.fileName)
  }

  @Test
  fun `deserialize unsubscribe_storage with subscriptionId matches the TS wire`() {
    // The TS client sends only subscriptionId ("packageName:fileName"). Verify the sealed class
    // decodes it without throwing; packageName/fileName are absent (the pre-migration no-op case).
    val message =
        """{"type":"unsubscribe_storage","requestId":"unsub-1","subscriptionId":"com.example.app:settings.xml"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<UnsubscribeStorage>(request)
    assertEquals("unsub-1", request.requestId)
    assertEquals("com.example.app:settings.xml", request.subscriptionId)
    assertEquals(null, request.packageName)
    assertEquals(null, request.fileName)
  }
}
