package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Test

class WebSocketResponseTest {
  private val json = Json {
    classDiscriminator = "type"
    encodeDefaults = true
  }

  @Test
  fun `traversal truncation metadata is optional and omitted when null`() {
    val complete = TraversalOrderData(elements = emptyList(), focusedIndex = null, totalCount = 0)
    val encoded = json.encodeToString(TraversalOrderData.serializer(), complete)
    assertFalse(encoded.contains("truncationReasons"))
    assertNull(json.decodeFromString(TraversalOrderData.serializer(), encoded).truncationReasons)

    val truncated = complete.copy(truncationReasons = listOf("max_children"))
    assertEquals(
      truncated,
      json.decodeFromString(
        TraversalOrderData.serializer(),
        json.encodeToString(TraversalOrderData.serializer(), truncated),
      ),
    )
  }

  @Test
  fun `serialize crash and ANR timestamps on the envelope`() {
    val deviceInfo = DeviceInfo("Pixel 7", "Google", "14", 34)
    val crash: WebSocketResponse =
      CrashEvent(
        timestamp = 1700000000000L,
        event =
          CrashData(
            exceptionClass = "java.lang.NullPointerException",
            message = null,
            stackTrace = "at com.example.Main.run(Main.java:42)",
            threadName = "main",
            packageName = "com.example.app",
            deviceInfo = deviceInfo,
          ),
      )
    val anr: WebSocketResponse =
      AnrEvent(
        timestamp = 1700000000500L,
        event =
          AnrData(
            pid = 12345,
            processName = "com.example.app",
            importance = "FOREGROUND",
            trace = null,
            reason = "Input dispatching timed out",
            packageName = "com.example.app",
            deviceInfo = deviceInfo,
          ),
      )

    assertEquals(
      """{"type":"crash_event","timestamp":1700000000000,"event":{"exceptionClass":"java.lang.NullPointerException","message":null,"stackTrace":"at com.example.Main.run(Main.java:42)","threadName":"main","currentScreen":null,"packageName":"com.example.app","appVersion":null,"deviceInfo":{"model":"Pixel 7","manufacturer":"Google","osVersion":"14","sdkInt":34},"applicationId":null}}""",
      json.encodeToString(WebSocketResponse.serializer(), crash),
    )
    assertEquals(
      """{"type":"anr_event","timestamp":1700000000500,"event":{"pid":12345,"processName":"com.example.app","importance":"FOREGROUND","trace":null,"reason":"Input dispatching timed out","packageName":"com.example.app","appVersion":null,"deviceInfo":{"model":"Pixel 7","manufacturer":"Google","osVersion":"14","sdkInt":34}}}""",
      json.encodeToString(WebSocketResponse.serializer(), anr),
    )
  }

  @Test
  fun `serialize swipe_result`() {
    val response: WebSocketResponse =
      SwipeResult(
        timestamp = 1234567890L,
        requestId = "swipe-1",
        success = true,
        totalTimeMs = 350L,
        gestureTimeMs = 300L,
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"swipe_result""""))
    assertTrue(encoded.contains(""""requestId":"swipe-1""""))
    assertTrue(encoded.contains(""""success":true"""))
    assertTrue(encoded.contains(""""totalTimeMs":350"""))
    assertTrue(encoded.contains(""""gestureTimeMs":300"""))
  }

  @Test
  fun `serialize screenshot_result`() {
    val response: WebSocketResponse =
      ScreenshotResult(
        timestamp = 1234567890L,
        requestId = "ss-1",
        data = "base64data",
        format = "png",
        width = 1080,
        height = 1920,
        rotation = 1,
        screenshotCaptureDurationMs = 42L,
        screenshotEncodeDurationMs = 7L,
        screenshotByteLength = 1200,
        screenshotBase64Length = 1600,
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue("\"rotation\":1" in encoded)

    assertTrue(encoded.contains(""""type":"screenshot""""))
    assertTrue(encoded.contains(""""requestId":"ss-1""""))
    assertTrue(encoded.contains(""""data":"base64data""""))
    assertTrue(encoded.contains(""""format":"png""""))
    assertTrue(encoded.contains(""""width":1080"""))
    assertTrue(encoded.contains(""""height":1920"""))
    assertTrue(encoded.contains(""""screenshotCaptureDurationMs":42"""))
    assertTrue(encoded.contains(""""screenshotEncodeDurationMs":7"""))
    assertTrue(encoded.contains(""""screenshotByteLength":1200"""))
    assertTrue(encoded.contains(""""screenshotBase64Length":1600"""))
  }

  @Test
  fun `serialize hierarchy_update event`() {
    val response: WebSocketResponse =
      HierarchyUpdateEvent(
        timestamp = 1234567890L,
        data = """{"nodes":[]}""",
        perfTiming = """{"total":50}""",
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"hierarchy_update""""))
    assertTrue(encoded.contains(""""data":"{\"nodes\":[]}""""))
    assertTrue(encoded.contains(""""perfTiming":"{\"total\":50}""""))
    assertTrue(encoded.contains("\"requestId\":null"), encoded)
  }

  @Test
  fun `serialize correlated hierarchy_update event`() {
    val response: WebSocketResponse =
      HierarchyUpdateEvent(timestamp = 123L, data = "{}", requestId = "req-1")

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""requestId":"req-1""""))
  }

  @Test
  fun `serialize connected response`() {
    val response: WebSocketResponse =
      ConnectedResponse(
        id = 1,
        supportedCommands = listOf("set_hierarchy_interval", "node_selector_actions"),
        timestamp = 1234567890L,
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"connected""""))
    assertTrue(encoded.contains(""""id":1"""))
    assertTrue(
      encoded.contains(""""supportedCommands":["set_hierarchy_interval","node_selector_actions"]""")
    )
  }

  @Test
  fun `serialize versioned keyboard profile catalog`() {
    val response: WebSocketResponse =
      KeyboardProfileCatalogResult(
        timestamp = 1L,
        requestId = "profiles-1",
        success = true,
        catalogId = "automobile_behavior_profiles",
        catalogVersion = 1,
        supportedCatalogVersions = listOf(1),
        activeProfileId = "gboard",
        profiles =
          listOf(
            KeyboardProfileInfo(
              id = "gboard",
              displayName = "Gboard",
              version = 1,
              evidenceStatus = "focused_trace",
              evidenceNote = "Focused trace comparison; full vendor equivalence is not claimed.",
              behavior =
                KeyboardProfileBehaviorInfo(
                  composeWords = true,
                  enterStrategy = "KEY_EVENT",
                  backspaceStrategy = "DELETE_SURROUNDING",
                  recomposeOnCursorMove = false,
                  recomposeOnBackspaceIntoWord = true,
                  batchEdits = true,
                ),
            )
          ),
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)
    assertTrue(encoded.contains("\"type\":\"keyboard_profiles_result\""))
    assertTrue(encoded.contains("\"catalogId\":\"automobile_behavior_profiles\""))
    assertTrue(encoded.contains("\"catalogVersion\":1"))
    assertTrue(encoded.contains("\"activeProfileId\":\"gboard\""))
    assertTrue(encoded.contains("\"enterStrategy\":\"KEY_EVENT\""))
  }

  @Test
  fun `serialize permission_result`() {
    val response: WebSocketResponse =
      PermissionResult(
        timestamp = 1234567890L,
        requestId = "perm-1",
        success = true,
        permission = "android.permission.CAMERA",
        granted = true,
        canRequest = false,
        totalTimeMs = 10L,
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"permission_result""""))
    assertTrue(encoded.contains(""""permission":"android.permission.CAMERA""""))
    assertTrue(encoded.contains(""""granted":true"""))
  }

  @Test
  fun `serialize error result`() {
    val response: WebSocketResponse =
      SwipeResult(
        timestamp = 1234567890L,
        requestId = "swipe-error",
        success = false,
        totalTimeMs = 100L,
        error = "Gesture failed: timeout",
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""success":false"""))
    assertTrue(encoded.contains(""""error":"Gesture failed: timeout""""))
  }

  @Test
  fun `serialize settings_get_result`() {
    val response: WebSocketResponse =
      SettingsGetResult(
        timestamp = 1234567890L,
        requestId = "sg-1",
        success = true,
        namespace = "system",
        key = "user_rotation",
        value = "0",
        found = true,
        totalTimeMs = 5L,
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"settings_get_result""""))
    assertTrue(encoded.contains(""""namespace":"system""""))
    assertTrue(encoded.contains(""""key":"user_rotation""""))
    assertTrue(encoded.contains(""""value":"0""""))
    assertTrue(encoded.contains(""""found":true"""))
    assertTrue(encoded.contains(""""totalTimeMs":5"""))
  }

  @Test
  fun `serialize settings_put_result with error`() {
    val response: WebSocketResponse =
      SettingsPutResult(
        timestamp = 1234567890L,
        requestId = "sp-1",
        success = false,
        namespace = "secure",
        key = "accessibility_enabled",
        totalTimeMs = 12L,
        error = "SecurityException: write secure requires WRITE_SECURE_SETTINGS",
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"settings_put_result""""))
    assertTrue(encoded.contains(""""success":false"""))
    assertTrue(encoded.contains(""""namespace":"secure""""))
    assertTrue(encoded.contains(""""error":"SecurityException"""))
  }

  @Test
  fun `serialize settings_list_result with entries`() {
    val response: WebSocketResponse =
      SettingsListResult(
        timestamp = 1234567890L,
        requestId = "sl-1",
        success = true,
        namespace = "global",
        entries = mapOf("zen_mode" to "0", "device_provisioned" to "1"),
        totalTimeMs = 30L,
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"settings_list_result""""))
    assertTrue(encoded.contains(""""namespace":"global""""))
    assertTrue(encoded.contains(""""zen_mode":"0""""))
    assertTrue(encoded.contains(""""device_provisioned":"1""""))
  }

  @Test
  fun `serialize installed_packages_result`() {
    val response: WebSocketResponse =
      InstalledPackagesResult(
        timestamp = 1234567890L,
        requestId = "pkg-1",
        success = true,
        userId = 0,
        packages =
          listOf(
            InstalledPackageRecord(
              packageName = "com.example.app",
              isSystem = false,
              versionName = "1.0",
              versionCode = 1L,
              label = "Example App",
              launchable = true,
            ),
            InstalledPackageRecord(packageName = "com.android.systemui", isSystem = true),
          ),
        totalTimeMs = 15L,
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"installed_packages_result""""))
    assertTrue(encoded.contains(""""userId":0"""))
    assertTrue(encoded.contains(""""packageName":"com.example.app""""))
    assertTrue(encoded.contains(""""isSystem":false"""))
    assertTrue(encoded.contains(""""versionName":"1.0""""))
    assertTrue(encoded.contains(""""versionCode":1"""))
    assertTrue(encoded.contains(""""packageName":"com.android.systemui""""))
    // #6798: the host reads these to answer "which package is Contacts?".
    assertTrue(encoded.contains(""""label":"Example App""""))
    assertTrue(encoded.contains(""""launchable":true"""))
  }

  @Test
  fun `serialize package_info_result`() {
    val response: WebSocketResponse =
      PackageInfoResult(
        timestamp = 1234567890L,
        requestId = "pi-1",
        success = true,
        packageName = "com.example.app",
        isSystem = false,
        applicationLabel = "Example",
        versionName = "2.3",
        versionCode = 42L,
        installerPackage = "com.android.vending",
        firstInstallTime = 100L,
        lastUpdateTime = 200L,
        allowBackup = true,
        requestedPermissions = listOf("android.permission.CAMERA", "android.permission.INTERNET"),
        grantedPermissions =
          mapOf("android.permission.CAMERA" to true, "android.permission.INTERNET" to false),
        mainActivity = "com.example.app/.MainActivity",
        totalTimeMs = 5L,
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"package_info_result""""))
    assertTrue(encoded.contains(""""packageName":"com.example.app""""))
    assertTrue(encoded.contains(""""applicationLabel":"Example""""))
    assertTrue(encoded.contains(""""versionName":"2.3""""))
    assertTrue(encoded.contains(""""versionCode":42"""))
    assertTrue(encoded.contains(""""installerPackage":"com.android.vending""""))
    assertTrue(encoded.contains(""""mainActivity":"com.example.app/.MainActivity""""))
    assertTrue(encoded.contains(""""android.permission.CAMERA":true"""))
    assertTrue(encoded.contains(""""android.permission.INTERNET":false"""))
  }

  @Test
  fun `serialize error response with requestId`() {
    val response: WebSocketResponse =
      ErrorResponse(
        timestamp = 1234567890L,
        requestId = "req-err",
        error = "Malformed request: the payload is not valid JSON",
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"error""""))
    assertTrue(encoded.contains(""""requestId":"req-err""""))
    assertTrue(encoded.contains(""""success":false"""))
    assertTrue(encoded.contains(""""error":"Malformed request: the payload is not valid JSON""""))
  }

  @Test
  fun `serialize error response without requestId emits null`() {
    val response: WebSocketResponse = ErrorResponse(timestamp = 1234567890L, error = "boom")

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"error""""))
    assertTrue(encoded.contains(""""requestId":null"""))
    assertTrue(encoded.contains(""""success":false"""))
    assertTrue(encoded.contains(""""error":"boom""""))
  }

  @Test
  fun `error response round-trips through sealed serializer`() {
    val original: WebSocketResponse =
      ErrorResponse(timestamp = 42L, requestId = "r1", error = "nope")
    val encoded = json.encodeToString(WebSocketResponse.serializer(), original)
    val decoded = json.decodeFromString(WebSocketResponse.serializer(), encoded)
    assertTrue(decoded is ErrorResponse, "expected ErrorResponse, was ${decoded::class.simpleName}")
    val error = decoded as ErrorResponse
    assertEquals("r1", error.requestId)
    assertFalse(error.success)
    assertEquals("nope", error.error)
  }

  @Test
  fun `serialize launch_intent_result`() {
    val response: WebSocketResponse =
      LaunchIntentResult(
        timestamp = 1234567890L,
        requestId = "li-1",
        success = true,
        packageName = "com.example.app",
        componentName = "com.example.app/.MainActivity",
        totalTimeMs = 3L,
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"launch_intent_result""""))
    assertTrue(encoded.contains(""""componentName":"com.example.app/.MainActivity""""))
    assertTrue(encoded.contains(""""packageName":"com.example.app""""))
  }

  @Test
  fun `serialize frame_metrics_event`() {
    val response: WebSocketResponse =
      FrameMetricsEventResponse(
        timestamp = 1234567890L,
        frameMetrics =
          FrameMetricsData(
            applicationId = "com.example.app",
            fps = 59.5,
            frameTimeMs = 16.8,
            jankFrames = 2,
            totalFrames = 58,
          ),
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"frame_metrics_event""""))
    assertTrue(encoded.contains(""""applicationId":"com.example.app""""))
    assertTrue(encoded.contains(""""fps":59.5"""))
    assertTrue(encoded.contains(""""jankFrames":2"""))
    assertTrue(encoded.contains(""""totalFrames":58"""))

    val decoded = json.decodeFromString(WebSocketResponse.serializer(), encoded)
    assertTrue(decoded is FrameMetricsEventResponse)
    assertEquals(59.5, (decoded as FrameMetricsEventResponse).frameMetrics.fps)
  }

  @Test
  fun `frame_metrics_event round-trips a no-frame window`() {
    val response: WebSocketResponse =
      FrameMetricsEventResponse(
        timestamp = 1L,
        frameMetrics = FrameMetricsData(applicationId = "com.example.app", totalFrames = 0),
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)
    val decoded =
      json.decodeFromString(WebSocketResponse.serializer(), encoded) as FrameMetricsEventResponse

    assertEquals(0, decoded.frameMetrics.totalFrames)
    assertEquals(null, decoded.frameMetrics.fps)
    assertEquals(null, decoded.frameMetrics.jankFrames)
  }

  @Test
  fun `overlay result missing assets round trip and are omitted when absent`() {
    val literal =
      """{"type":"overlay_result","timestamp":42,"requestId":"r1","success":true,"error":null,"missingAssets":["hero","logo"]}"""
    val decoded = assertIs<OverlayResult>(json.decodeFromString<WebSocketResponse>(literal))
    assertEquals(listOf("hero", "logo"), decoded.missingAssets)
    assertEquals(literal, json.encodeToString<WebSocketResponse>(decoded))
    // Peers that predate the field: it decodes as absent and is never written back as null.
    val legacy = """{"type":"overlay_result","timestamp":42,"requestId":"r1","success":true}"""
    val legacyDecoded = assertIs<OverlayResult>(json.decodeFromString<WebSocketResponse>(legacy))
    assertNull(legacyDecoded.missingAssets)
    assertFalse(json.encodeToString<WebSocketResponse>(legacyDecoded).contains("missingAssets"))
  }

  @Test
  fun `overlay result echoes request id and event has no request id`() {
    val resultLiteral =
      """{"type":"overlay_result","timestamp":42,"requestId":"r1","success":false,"error":"overlay host not wired"}"""
    val result = json.decodeFromString<WebSocketResponse>(resultLiteral)
    assertEquals("r1", assertIs<OverlayResult>(result).requestId)
    assertEquals(resultLiteral, json.encodeToString<WebSocketResponse>(result))
    val eventLiteral =
      """{"type":"overlay_event","timestamp":42,"id":"panel","sequence":1,"kind":"emit","name":"next","payload":{"nested":[true,null]},"state":{"label":"Next","enabled":true},"pages":{"pager":0}}"""
    val event = assertIs<OverlayEvent>(json.decodeFromString<WebSocketResponse>(eventLiteral))
    assertEquals(OverlayEventKind.EMIT, event.kind)
    assertEquals(1L, event.sequence)
    assertEquals(mapOf("pager" to 0), event.pages)
    assertEquals(eventLiteral, json.encodeToString<WebSocketResponse>(event))
    assertFalse(json.encodeToString<WebSocketResponse>(event).contains("requestId"))
    for (kind in listOf("page_changed", "dismissed")) {
      val literal =
        """{"type":"overlay_event","timestamp":42,"id":"panel","sequence":2,"kind":"$kind","name":null,"payload":null,"state":{},"pages":{}}"""
      assertEquals(
        literal,
        json.encodeToString<WebSocketResponse>(json.decodeFromString<WebSocketResponse>(literal)),
      )
    }
    assertFailsWith<SerializationException> {
      json.decodeFromString<WebSocketResponse>(eventLiteral.replace("emit", "unknown"))
    }
  }
}
