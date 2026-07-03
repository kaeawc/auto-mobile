package dev.jasonpearson.automobile.protocol

import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Test

class WebSocketResponseTest {
  private val json = Json {
    classDiscriminator = "type"
    encodeDefaults = true
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
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"screenshot""""))
    assertTrue(encoded.contains(""""requestId":"ss-1""""))
    assertTrue(encoded.contains(""""data":"base64data""""))
    assertTrue(encoded.contains(""""format":"png""""))
    assertTrue(encoded.contains(""""width":1080"""))
    assertTrue(encoded.contains(""""height":1920"""))
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
  }

  @Test
  fun `serialize connected response`() {
    val response: WebSocketResponse =
      ConnectedResponse(
        id = 1,
        timestamp = 1234567890L,
      )

    val encoded = json.encodeToString(WebSocketResponse.serializer(), response)

    assertTrue(encoded.contains(""""type":"connected""""))
    assertTrue(encoded.contains(""""id":1"""))
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
}
