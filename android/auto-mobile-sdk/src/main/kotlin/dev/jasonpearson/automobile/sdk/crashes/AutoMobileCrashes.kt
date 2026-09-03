package dev.jasonpearson.automobile.sdk.crashes

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import dev.jasonpearson.automobile.protocol.SdkCrashEvent
import dev.jasonpearson.automobile.protocol.SdkDeviceInfo
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.SdkConstants
import dev.jasonpearson.automobile.sdk.breadcrumbs.Breadcrumb
import dev.jasonpearson.automobile.sdk.breadcrumbs.BreadcrumbTracking
import java.io.PrintWriter
import java.io.StringWriter
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject

/**
 * SDK API for detecting and reporting unhandled crashes.
 *
 * Similar to Firebase Crashlytics or Bugsnag, this installs an UncaughtExceptionHandler that
 * broadcasts crash information to the accessibility service before the app terminates.
 *
 * Usage:
 * ```kotlin
 * // Initialize via AutoMobileSDK.initialize() or directly
 * AutoMobileCrashes.initialize(applicationContext)
 * ```
 *
 * When a crash occurs:
 * 1. The UncaughtExceptionHandler captures the exception
 * 2. Crash info is broadcast to the AutoMobile accessibility service
 * 3. The original handler is called (to preserve default crash behavior)
 */
object AutoMobileCrashes {
  private const val TAG = "AutoMobileCrashes"

  private const val ACCESSIBILITY_SERVICE_PACKAGE = SdkConstants.CTRL_PROXY_PACKAGE

  const val ACTION_CRASH = "dev.jasonpearson.automobile.sdk.CRASH"
  const val EXTRA_TIMESTAMP = "timestamp"
  const val EXTRA_EXCEPTION_CLASS = "exception_class"
  const val EXTRA_EXCEPTION_MESSAGE = "exception_message"
  const val EXTRA_STACK_TRACE = "stack_trace"
  const val EXTRA_THREAD_NAME = "thread_name"
  const val EXTRA_CURRENT_SCREEN = "current_screen"
  const val EXTRA_PACKAGE_NAME = "package_name"
  const val EXTRA_APP_VERSION = "app_version"
  const val EXTRA_DEVICE_MODEL = "device_model"
  const val EXTRA_DEVICE_MANUFACTURER = "device_manufacturer"
  const val EXTRA_OS_VERSION = "os_version"
  const val EXTRA_SDK_INT = "sdk_int"
  const val EXTRA_BREADCRUMBS = "breadcrumbs"

  /** Maximum size in bytes for the breadcrumbs JSON extra. */
  private const val MAX_BREADCRUMBS_BYTES = 50_000

  private var context: Context? = null
  @Volatile private var originalHandler: Thread.UncaughtExceptionHandler? = null
  private val isInstalled = AtomicBoolean(false)

  /** Provider for current screen name - set by navigation tracking */
  var currentScreenProvider: (() -> String?)? = null

  /** Breadcrumb trail attached to crash reports. Set by AutoMobileSDK. */
  var breadcrumbTrail: BreadcrumbTracking? = null

  /**
   * Initialize crash detection with application context.
   *
   * This installs an UncaughtExceptionHandler that will:
   * 1. Broadcast crash info to the accessibility service
   * 2. Call the original handler (preserving default behavior)
   *
   * @param context Application context (use applicationContext, not activity context)
   */
  fun initialize(context: Context) {
    if (!isInstalled.compareAndSet(false, true)) {
      AutoMobileSDK.logger.d(TAG) { "AutoMobileCrashes already initialized" }
      return
    }

    this.context = context.applicationContext

    // Capture the predecessor in the installed handler. It must remain available after uninstall
    // because a later crash reporter may retain this handler as its delegate.
    val originalHandler = Thread.getDefaultUncaughtExceptionHandler()
    this.originalHandler = originalHandler
    Thread.setDefaultUncaughtExceptionHandler(AutoMobileExceptionHandler())

    AutoMobileSDK.logger.d(TAG) { "AutoMobileCrashes initialized - crash detection enabled" }
  }

  /** Check if crash detection is initialized. */
  fun isInitialized(): Boolean = isInstalled.get()

  /** Uninstall crash detection, restoring the original uncaught exception handler. */
  fun uninstall() {
    if (!isInstalled.compareAndSet(true, false)) return
    // Only restore the original handler if we're still the current handler.
    // Another SDK may have installed a handler after us — don't clobber it.
    val currentHandler = Thread.getDefaultUncaughtExceptionHandler()
    if (currentHandler is AutoMobileExceptionHandler) {
      Thread.setDefaultUncaughtExceptionHandler(originalHandler)
    }
    originalHandler = null
    context = null
    currentScreenProvider = null
    breadcrumbTrail = null
    AutoMobileSDK.logger.d(TAG) { "AutoMobileCrashes uninstalled - crash detection disabled" }
  }

  private class AutoMobileExceptionHandler : Thread.UncaughtExceptionHandler {
    private val originalHandler = AutoMobileCrashes.originalHandler

    override fun uncaughtException(thread: Thread, throwable: Throwable) {
      if (AutoMobileSDK.isTrackingEnabled) {
        try {
          // Broadcast the crash before the app terminates
          broadcastCrash(thread, throwable)
        } catch (e: Exception) {
          AutoMobileSDK.logger.e(TAG, e) { "Failed to broadcast crash" }
        }
      }

      // Call the original handler to preserve default crash behavior
      // This ensures the app terminates normally and system crash dialogs appear
      try {
        originalHandler?.uncaughtException(thread, throwable)
      } catch (e: Exception) {
        // Original handler threw — ensure process terminates
        Runtime.getRuntime().exit(1)
      }
    }
  }

  private fun broadcastCrash(thread: Thread, throwable: Throwable) {
    val ctx =
      context
        ?: run {
          AutoMobileSDK.logger.w(TAG) { "Context not available, cannot broadcast crash" }
          return
        }

    try {
      val timestamp = System.currentTimeMillis()
      val stackTrace = StringWriter().also { throwable.printStackTrace(PrintWriter(it)) }.toString()

      // Collect all-thread dumps for full crash context.
      // Cap total size to avoid exceeding Android's 1MB Binder transaction limit
      // when sending the broadcast (the payload is duplicated in both JSON and
      // legacy extras, so 50KB keeps us well under the 100KB batch limit).
      val maxAllThreadBytes = 50_000
      val allThreadsBuilder = StringBuilder(stackTrace)
      allThreadsBuilder.append("\n\n--- All Threads ---\n")
      val allTraces = Thread.getAllStackTraces()
      var includedCount = 0
      var truncated = false
      for ((t, frames) in allTraces) {
        if (t.id == thread.id) continue // skip crashing thread (already included)
        val threadDump = buildString {
          append("\n\"${t.name}\" ${t.state}\n")
          for (frame in frames) {
            append("    at $frame\n")
          }
        }
        if (allThreadsBuilder.length + threadDump.length > maxAllThreadBytes) {
          truncated = true
          break
        }
        allThreadsBuilder.append(threadDump)
        includedCount++
      }
      if (truncated) {
        val totalOtherThreads = allTraces.keys.count { it.id != thread.id }
        val remaining = totalOtherThreads - includedCount
        allThreadsBuilder.append("\n(truncated — $remaining more threads omitted)\n")
      }
      val fullStackTrace = allThreadsBuilder.toString()

      val currentScreen = currentScreenProvider?.invoke()
      val appVersion = getAppVersion(ctx)

      // Create protocol event for type-safe serialization
      val sdkEvent =
        SdkCrashEvent(
          timestamp = timestamp,
          applicationId = ctx.packageName,
          exceptionClass = throwable.javaClass.name,
          exceptionMessage = throwable.message,
          stackTrace = fullStackTrace,
          threadName = thread.name,
          currentScreen = currentScreen,
          appVersion = appVersion,
          deviceInfo =
            SdkDeviceInfo(
              model = Build.MODEL,
              manufacturer = Build.MANUFACTURER,
              osVersion = Build.VERSION.RELEASE,
              sdkInt = Build.VERSION.SDK_INT,
            ),
        )

      val intent =
        Intent(ACTION_CRASH).apply {
          // Scope broadcast to only the accessibility service to prevent data leakage
          setPackage(ACCESSIBILITY_SERVICE_PACKAGE)

          // Type-safe serialized event (new protocol)
          putExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON, SdkEventSerializer.toJson(sdkEvent))
          putExtra(SdkEventSerializer.EXTRA_SDK_EVENT_TYPE, SdkEventSerializer.EventTypes.CRASH)

          // Legacy extras for backward compatibility
          putExtra(EXTRA_TIMESTAMP, timestamp)
          putExtra(EXTRA_EXCEPTION_CLASS, throwable.javaClass.name)
          putExtra(EXTRA_EXCEPTION_MESSAGE, throwable.message)
          putExtra(EXTRA_STACK_TRACE, fullStackTrace)
          putExtra(EXTRA_THREAD_NAME, thread.name)
          putExtra(EXTRA_CURRENT_SCREEN, currentScreen)
          putExtra(EXTRA_PACKAGE_NAME, ctx.packageName)
          putExtra(EXTRA_APP_VERSION, appVersion)
          putExtra(EXTRA_DEVICE_MODEL, Build.MODEL)
          putExtra(EXTRA_DEVICE_MANUFACTURER, Build.MANUFACTURER)
          putExtra(EXTRA_OS_VERSION, Build.VERSION.RELEASE)
          putExtra(EXTRA_SDK_INT, Build.VERSION.SDK_INT)

          // Attach breadcrumb trail snapshot
          serializeBreadcrumbs()?.let { putExtra(EXTRA_BREADCRUMBS, it) }
        }

      ctx.sendBroadcast(intent)

      // Allow time for the broadcast to be dispatched before process termination
      try {
        Thread.sleep(200)
      } catch (_: InterruptedException) {}

      AutoMobileSDK.logger.i(TAG) {
        "Broadcasted crash: ${throwable.javaClass.name} on thread ${thread.name}"
      }
    } catch (e: Exception) {
      AutoMobileSDK.logger.e(TAG, e) { "Failed to broadcast crash" }
    }
  }

  /**
   * Serialize the breadcrumb trail snapshot to a JSON string. If the result exceeds
   * [MAX_BREADCRUMBS_BYTES], the oldest breadcrumbs are dropped until it fits.
   */
  private fun serializeBreadcrumbs(): String? {
    val crumbs = breadcrumbTrail?.snapshot() ?: return null
    if (crumbs.isEmpty()) return null

    val json = breadcrumbsToJson(crumbs)
    if (json.toByteArray(Charsets.UTF_8).size <= MAX_BREADCRUMBS_BYTES) return json

    // Binary search for the largest suffix that fits within the size limit.
    var lo = 1
    var hi = crumbs.size - 1
    var bestStart = crumbs.size // nothing fits
    while (lo <= hi) {
      val mid = (lo + hi) / 2
      val candidate = breadcrumbsToJson(crumbs.subList(mid, crumbs.size))
      if (candidate.toByteArray(Charsets.UTF_8).size <= MAX_BREADCRUMBS_BYTES) {
        bestStart = mid
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }
    if (bestStart >= crumbs.size) return null
    return breadcrumbsToJson(crumbs.subList(bestStart, crumbs.size))
  }

  private fun breadcrumbsToJson(list: List<Breadcrumb>): String {
    val arr = JSONArray()
    for (bc in list) {
      val obj = JSONObject()
      obj.put("timestamp", bc.timestamp)
      obj.put("category", bc.category.name)
      obj.put("message", bc.message)
      if (bc.metadata.isNotEmpty()) {
        obj.put("metadata", JSONObject(bc.metadata))
      }
      arr.put(obj)
    }
    return arr.toString()
  }

  private fun getAppVersion(context: Context): String? {
    return try {
      val packageInfo =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          context.packageManager.getPackageInfo(
            context.packageName,
            PackageManager.PackageInfoFlags.of(0),
          )
        } else {
          @Suppress("DEPRECATION") context.packageManager.getPackageInfo(context.packageName, 0)
        }
      packageInfo.versionName
    } catch (e: Exception) {
      AutoMobileSDK.logger.w(TAG, e) { "Failed to get app version" }
      null
    }
  }
}
