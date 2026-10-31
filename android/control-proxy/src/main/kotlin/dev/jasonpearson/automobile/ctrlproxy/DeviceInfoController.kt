package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.util.Log
import dev.jasonpearson.automobile.protocol.DeviceInfoResult

/** Device facts and device-info requests, with service and socket access supplied. */
internal class DeviceInfoController(
  private val context: Context,
  private val serviceInfo: () -> AccessibilityServiceInfo?,
  private val displayController: DisplayController,
  private val asyncActionRunner: AsyncActionRunner,
  private val broadcast: suspend (DeviceInfoResult) -> Unit,
) {
  companion object {
    private const val TAG = "CtrlProxy"
  }

  /** Get device wakefulness state: "Awake", "Asleep", or "Dozing". */
  // Wakefulness queries must return a fallback even for unexpected platform exceptions.
  @Suppress("TooGenericExceptionCaught")
  fun getWakefulness(): String {
    return try {
      val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
      if (powerManager == null) {
        "Awake"
      } else if (powerManager.isDeviceIdleMode) {
        "Dozing"
      } else if (powerManager.isInteractive) {
        "Awake"
      } else {
        "Asleep"
      }
    } catch (e: Exception) {
      Log.w(TAG, "Failed to get wakefulness", e)
      "Awake"
    }
  }

  /**
   * Get the foreground activity component name using accessibility service state. Uses
   * rootInActiveWindow (reliable on all API levels) + lastWindowClassName from
   * TYPE_WINDOW_STATE_CHANGED events, avoiding the restricted ActivityManager.getRunningTasks()
   * API.
   */
  // Foreground activity queries must return null even for unexpected exceptions.
  @Suppress("TooGenericExceptionCaught")
  fun getForegroundActivity(
    rootPackage: String? = null,
    windowClass: String? = null,
  ): String? {
    return try {
      val pkg = rootPackage
      val className = windowClass
      if (pkg != null && className != null) {
        if (isFrameworkViewClass(className)) {
          // Accessibility reports the root View class for many app windows,
          // which is not the resumed Activity and must not shadow the ADB
          // fallback on the host.
          return null
        }
        // Use short class name format if it starts with the package
        val shortName =
          if (className.startsWith(pkg)) {
            className.removePrefix(pkg)
          } else {
            className
          }
        "$pkg/$shortName"
      } else {
        // Don't return package-only value — it produces an empty activityName
        // in ObserveScreen and prevents the ADB fallback from filling the real one
        null
      }
    } catch (e: Exception) {
      Log.w(TAG, "Failed to get foreground activity", e)
      null
    }
  }

  private fun isFrameworkViewClass(className: String): Boolean =
    className.startsWith("android.widget.") ||
      className.startsWith("android.view.") ||
      className.endsWith("DecorView")

  /** Check if running on an emulator. */
  /**
   * Runtime `AccessibilityServiceInfo.isAccessibilityTool` of this bound service (#6233). The
   * getter exists from API 31; below that (or without serviceInfo) the value is unknown (null).
   */
  fun getAccessibilityTool(): Boolean? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) serviceInfo()?.isAccessibilityTool else null

  fun getIsEmulator(): Boolean {
    return (Build.FINGERPRINT.startsWith("generic") ||
      Build.FINGERPRINT.startsWith("unknown") ||
      Build.MODEL.contains("google_sdk") ||
      Build.MODEL.contains("Emulator") ||
      Build.MODEL.contains("Android SDK built for x86") ||
      Build.MANUFACTURER.contains("Genymotion") ||
      Build.HARDWARE.contains("goldfish") ||
      Build.HARDWARE.contains("ranchu") ||
      Build.PRODUCT.contains("sdk_gphone") ||
      Build.PRODUCT.contains("emulator") ||
      Build.PRODUCT.contains("simulator"))
  }

  /** Handle a request_device_info WebSocket message. */
  fun performDeviceInfoRequest(requestId: String?) {
    val startTime = System.currentTimeMillis()
    val screenDimensions = displayController.getScreenDimensions()
    val foreground = getForegroundActivity()
    val totalTimeMs = System.currentTimeMillis() - startTime
    asyncActionRunner.launch(requestId, "request_device_info") {
      broadcast(
        DeviceInfoResult(
          timestamp = System.currentTimeMillis(),
          requestId = requestId,
          success = true,
          screenWidth = screenDimensions?.width,
          screenHeight = screenDimensions?.height,
          density = displayController.getDensity(),
          rotation = displayController.getRotation(),
          sdkInt = Build.VERSION.SDK_INT,
          deviceModel = Build.MODEL,
          isEmulator = getIsEmulator(),
          wakefulness = getWakefulness(),
          foregroundActivity = foreground,
          totalTimeMs = totalTimeMs,
        ),
      )
    }
  }
}
