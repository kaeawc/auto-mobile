package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Test

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
  fun `deserialize request_hierarchy snapshot limits`() {
    val message =
      """{"type":"request_hierarchy","requestId":"bounded","maxDepth":8,"maxNodes":128}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestHierarchy>(request)
    assertEquals(8, request.maxDepth)
    assertEquals(128, request.maxNodes)
  }

  @Test
  fun `deserialize request_tap_coordinates`() {
    val message = """{"type":"request_tap_coordinates","requestId":"tap-1","x":100,"y":200}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestTapCoordinates>(request)
    assertEquals("tap-1", request.requestId)
    assertEquals(100.0, request.x)
    assertEquals(200.0, request.y)
    assertEquals(10L, request.duration) // default
  }

  @Test
  fun `deserialize request_tap_coordinates with fractional coordinates`() {
    // Coordinate fields are Double (#2927): a fractional JSON number must decode
    // without a kotlinx decode error and preserve the fraction.
    val message =
      """{"type":"request_tap_coordinates","requestId":"tap-frac","x":100.5,"y":200.25}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestTapCoordinates>(request)
    assertEquals(100.5, request.x)
    assertEquals(200.25, request.y)
  }

  @Test
  fun `deserialize request_swipe`() {
    val message =
      """{"type":"request_swipe","requestId":"swipe-1","x1":0,"y1":100,"x2":0,"y2":500,"duration":400}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestSwipe>(request)
    assertEquals("swipe-1", request.requestId)
    assertEquals(0.0, request.x1)
    assertEquals(100.0, request.y1)
    assertEquals(0.0, request.x2)
    assertEquals(500.0, request.y2)
    assertEquals(400L, request.duration)
  }

  @Test
  fun `deserialize request_swipe with fractional coordinates`() {
    val message =
      """{"type":"request_swipe","requestId":"swipe-frac","x1":0.5,"y1":100.25,"x2":10.75,"y2":500.125,"duration":400}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestSwipe>(request)
    assertEquals(0.5, request.x1)
    assertEquals(100.25, request.y1)
    assertEquals(10.75, request.x2)
    assertEquals(500.125, request.y2)
  }

  @Test
  fun `deserialize request_two_finger_swipe with fractional coordinates`() {
    val message =
      """{"type":"request_two_finger_swipe","requestId":"tfs-frac","x1":0.5,"y1":0.25,"x2":10.75,"y2":20.125,"duration":300,"offset":50}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestTwoFingerSwipe>(request)
    assertEquals(0.5, request.x1)
    assertEquals(0.25, request.y1)
    assertEquals(10.75, request.x2)
    assertEquals(20.125, request.y2)
    assertEquals(50, request.offset) // offset stays Int (pixel offset, not a coordinate)
  }

  @Test
  fun `deserialize request_drag with legacy fields`() {
    val message =
      """{"type":"request_drag","requestId":"drag-1","x1":50,"y1":50,"x2":150,"y2":150,"holdTime":800,"duration":500}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestDrag>(request)
    assertEquals("drag-1", request.requestId)
    assertEquals(50.0, request.x1)
    assertEquals(50.0, request.y1)
    assertEquals(150.0, request.x2)
    assertEquals(150.0, request.y2)
    // Legacy fields are used as fallback
    assertEquals(800L, request.resolvedPressDurationMs)
    assertEquals(500L, request.resolvedDragDurationMs)
  }

  @Test
  fun `deserialize request_drag with fractional coordinates`() {
    val message =
      """{"type":"request_drag","requestId":"drag-frac","x1":50.5,"y1":50.25,"x2":150.75,"y2":150.125}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestDrag>(request)
    assertEquals(50.5, request.x1)
    assertEquals(50.25, request.y1)
    assertEquals(150.75, request.x2)
    assertEquals(150.125, request.y2)
  }

  @Test
  fun `deserialize request_pinch`() {
    val message =
      """{"type":"request_pinch","requestId":"pinch-1","centerX":540,"centerY":960,"distanceStart":100,"distanceEnd":300,"rotationDegrees":45.0,"duration":500}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestPinch>(request)
    assertEquals("pinch-1", request.requestId)
    assertEquals(540.0, request.centerX)
    assertEquals(960.0, request.centerY)
    assertEquals(100.0, request.distanceStart)
    assertEquals(300.0, request.distanceEnd)
    assertEquals(45.0f, request.rotationDegrees)
    assertEquals(500L, request.duration)
  }

  @Test
  fun `deserialize request_pinch with fractional coordinates`() {
    // The iOS-symmetric case (#2927): sub-pixel center + computed fractional distance
    // must decode without a kotlinx decode error and keep the fraction.
    val message =
      """{"type":"request_pinch","requestId":"pinch-frac","centerX":100.5,"centerY":200.25,"distanceStart":80.5,"distanceEnd":120.75,"rotationDegrees":45.0,"duration":500}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestPinch>(request)
    assertEquals(100.5, request.centerX)
    assertEquals(200.25, request.centerY)
    assertEquals(80.5, request.distanceStart)
    assertEquals(120.75, request.distanceEnd)
    assertEquals(45.0f, request.rotationDegrees)
    assertEquals(500L, request.duration)
  }

  @Test
  fun `request_pinch still rejects a missing required coordinate`() {
    // Widening the coordinate fields to Double (#2927) must not weaken required-field decode:
    // they stay non-null with no default, so an absent coordinate is still a decode error.
    val message =
      """{"type":"request_pinch","requestId":"pinch-missing","centerX":100.0,"centerY":200.0,"distanceStart":80.0,"rotationDegrees":45.0,"duration":500}"""
    assertFailsWith<SerializationException> { json.decodeFromString<WebSocketRequest>(message) }
  }

  @Test
  fun `deserialize request_set_text`() {
    val message =
      """{"type":"request_set_text","requestId":"text-1","text":"Hello World","resourceId":"input_field"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestSetText>(request)
    assertEquals("text-1", request.requestId)
    assertEquals("Hello World", request.text)
    assertEquals("input_field", request.resourceId)
  }

  @Test
  fun `deserialize request_insert_text`() {
    val message =
      """{"type":"request_insert_text","requestId":"insert-1","text":"Hello World"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<RequestInsertText>(request)
    assertEquals("insert-1", request.requestId)
    assertEquals("Hello World", request.text)
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
