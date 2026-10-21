package dev.jasonpearson.automobile.protocol

import kotlin.test.assertTrue
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test

class WebSocketResponseDeviceTest : WebSocketResponseTestSupport() {
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
      encoded.contains(
        """"supportedCommands":["set_hierarchy_interval","node_selector_actions"]""",
      ),
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
            ),
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
}
