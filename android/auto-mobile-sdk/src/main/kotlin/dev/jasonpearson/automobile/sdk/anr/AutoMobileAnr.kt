package dev.jasonpearson.automobile.sdk.anr

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import androidx.annotation.RequiresApi
import dev.jasonpearson.automobile.protocol.SdkAnrEvent
import dev.jasonpearson.automobile.protocol.SdkDeviceInfo
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.SdkConstants
import java.io.InputStream

/**
 * SDK API for detecting ANRs (Application Not Responding) from previous sessions.
 *
 * Uses Android's ApplicationExitInfo API (Android 11+) to detect ANRs that occurred in previous
 * sessions and broadcasts them to the AutoMobile accessibility service.
 *
 * Unlike crash detection which happens in real-time, ANR detection happens on app restart because
 * ApplicationExitInfo only provides historical data about past exits.
 *
 * Usage:
 * ```kotlin
 * // Initialize via AutoMobileSDK.initialize() or directly
 * AutoMobileAnr.initialize(applicationContext)
 * ```
 *
 * When an ANR is detected from a previous session:
 * 1. ApplicationExitInfo is queried for REASON_ANR entries
 * 2. New ANRs (not previously reported) are broadcast to AccessibilityService
 * 3. The latest reported timestamp and identities reported at that timestamp are persisted to avoid
 *    duplicate reporting
 */
object AutoMobileAnr {
  private const val TAG = "AutoMobileAnr"

  private const val ACCESSIBILITY_SERVICE_PACKAGE = SdkConstants.CTRL_PROXY_PACKAGE

  const val ACTION_ANR = "dev.jasonpearson.automobile.sdk.ANR"

  private const val PREFS_NAME = "automobile_anr_prefs"
  private const val KEY_LAST_REPORTED_TIMESTAMP = "last_reported_anr_timestamp"
  private const val KEY_LAST_REPORTED_IDS = "last_reported_anr_ids_at_timestamp"

  // Null identities mean a legacy watermark: every entry at that timestamp is already reported.
  private data class AnrCursor(val timestamp: Long, val idsAtTimestamp: Set<String>?)

  /** Maximum number of historical exit reasons to query */
  private const val MAX_EXIT_REASONS = 5

  // Cap total size to avoid exceeding Android's 1MB Binder transaction limit
  // when sending the broadcast (the trace is also carried in the intent's JSON payload).
  private const val MAX_ANR_TRACE_CHARS = 200_000

  private var context: Context? = null

  /**
   * Initialize ANR detection with application context.
   *
   * This will query ApplicationExitInfo for any ANRs that occurred in previous sessions and
   * broadcast them to the accessibility service.
   *
   * Does nothing on Android versions below 11 (API 30).
   *
   * @param context Application context (use applicationContext, not activity context)
   */
  fun initialize(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      AutoMobileSDK.logger.d(TAG) { "ANR detection requires Android 11+ (API 30)" }
      return
    }

    this.context = context.applicationContext
    AutoMobileSDK.logger.d(TAG) { "AutoMobileAnr initialized, checking for previous ANRs..." }
    checkForPreviousAnrs()
  }

  /** Check if ANR detection is available on this device. */
  fun isAvailable(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R

  /** Clears the retained application context during SDK shutdown or a failed initialization. */
  internal fun reset() {
    context = null
  }

  @RequiresApi(Build.VERSION_CODES.R)
  private fun checkForPreviousAnrs() {
    val ctx = context ?: return

    try {
      val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
      if (am == null) {
        AutoMobileSDK.logger.w(TAG) { "ActivityManager not available" }
        return
      }

      // Get exit reasons for our own package (null = current package)
      val exitInfos = am.getHistoricalProcessExitReasons(null, 0, MAX_EXIT_REASONS)
      AutoMobileSDK.logger.d(TAG) { "Found ${exitInfos.size} historical exit reasons" }

      val lastReported = getLastReportedCursor(ctx)
      AutoMobileSDK.logger.d(TAG) { "Last reported ANR timestamp: ${lastReported.timestamp}" }

      val anrInfos = exitInfos.filter { it.reason == ApplicationExitInfo.REASON_ANR }
      AutoMobileSDK.logger.d(TAG) { "Found ${anrInfos.size} ANR(s) in exit history" }
      val newestReported =
        reportNewAnrs(
          anrInfos,
          { it.timestamp },
          // The name is never null; length-prefix it to distinguish empty names and separators.
          { "${it.pid}:${it.processName.length}:${it.processName}" },
          lastReported,
        ) { exitInfo ->
          AutoMobileSDK.logger.d(TAG) {
            "Detected NEW previous ANR: pid=${exitInfo.pid}, time=${exitInfo.timestamp}"
          }
          broadcastAnr(ctx, exitInfo)
        }

      // Persist successful ties as well as timestamp advances, in one preferences transaction.
      if (newestReported != lastReported) {
        setLastReportedCursor(ctx, newestReported)
        AutoMobileSDK.logger.d(TAG) {
          "Updated last reported timestamp to ${newestReported.timestamp}"
        }
      }
    } catch (e: Exception) {
      AutoMobileSDK.logger.e(TAG, e) { "Error checking for previous ANRs" }
    }
  }

  // Private pure seams keep the javap-based public API signature unchanged.
  private fun readCappedAnrTrace(stream: InputStream?, maxChars: Int): String? {
    if (stream == null) return null
    require(maxChars >= 0) { "maxChars must not be negative" }
    val trace = StringBuilder()
    var capped = false
    var readFailed = false
    try {
      stream.reader(Charsets.UTF_8).use { reader ->
        val buffer = CharArray(8192)
        while (trace.length < maxChars) {
          val count = reader.read(buffer, 0, minOf(buffer.size, maxChars - trace.length))
          if (count == -1) break
          trace.append(buffer, 0, count)
        }
        capped = trace.length == maxChars && reader.read() != -1
      }
    } catch (e: Exception) {
      AutoMobileSDK.logger.w(TAG, e) {
        "Failed to read or close ANR trace after ${trace.length} chars"
      }
      readFailed = true
    }
    val charsRead = trace.length
    if (capped) trace.append("\n(truncated — trace capped at $maxChars chars)\n")
    if (readFailed) {
      trace.append("\n(truncated — trace read failed after $charsRead chars)\n")
    }
    return trace.toString()
  }

  /**
   * Report oldest first, stopping at the first failure so the watermark cannot skip an ANR. With
   * the trace cap, sends are expected to succeed. Any failure is retried on the next app launch
   * through initialize; there is no in-process retry loop. Inlining send also avoids adding a
   * public JVM accessor for the private broadcast method.
   */
  private inline fun <T> reportNewAnrs(
    items: List<T>,
    noinline timestampOf: (T) -> Long,
    identityOf: (T) -> String,
    lastReported: AnrCursor,
    send: (T) -> Boolean,
  ): AnrCursor {
    var watermark = lastReported.timestamp
    var reportedIds: Set<String>? = lastReported.idsAtTimestamp
    for (item in items.sortedBy(timestampOf)) {
      val timestamp = timestampOf(item)
      val identity = identityOf(item)
      val shouldSkip =
        timestamp < watermark ||
          (timestamp == watermark && (reportedIds == null || identity in reportedIds.orEmpty()))
      if (shouldSkip) {
        AutoMobileSDK.logger.d(TAG) {
          "Skipping already reported ANR: time=$timestamp, identity=$identity"
        }
        continue
      }
      if (!send(item)) break
      if (timestamp > watermark) {
        watermark = timestamp
        reportedIds = emptySet()
      }
      reportedIds = reportedIds.orEmpty() + identity
    }
    return AnrCursor(watermark, reportedIds)
  }

  @RequiresApi(Build.VERSION_CODES.R)
  private fun broadcastAnr(context: Context, exitInfo: ApplicationExitInfo): Boolean {
    return try {
      // Read the trace from the input stream
      val trace =
        try {
          readCappedAnrTrace(exitInfo.traceInputStream, MAX_ANR_TRACE_CHARS)
        } catch (e: Exception) {
          AutoMobileSDK.logger.w(TAG, e) { "Failed to read ANR trace" }
          null
        }

      val event =
        SdkAnrEvent(
          timestamp = exitInfo.timestamp,
          applicationId = context.packageName,
          pid = exitInfo.pid,
          processName = exitInfo.processName.orEmpty(),
          importance = getImportanceName(exitInfo.importance),
          trace = trace,
          reason = "Application Not Responding",
          appVersion = getAppVersion(context),
          deviceInfo =
            SdkDeviceInfo(
              model = Build.MODEL,
              manufacturer = Build.MANUFACTURER,
              osVersion = Build.VERSION.RELEASE,
              sdkInt = Build.VERSION.SDK_INT,
            ),
        )

      val intent =
        Intent(ACTION_ANR).apply {
          // Scope broadcast to only the accessibility service
          setPackage(ACCESSIBILITY_SERVICE_PACKAGE)

          // Type-safe serialized event
          putExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON, SdkEventSerializer.toJson(event))
          putExtra(SdkEventSerializer.EXTRA_SDK_EVENT_TYPE, SdkEventSerializer.EventTypes.ANR)
        }

      context.sendBroadcast(intent)
      AutoMobileSDK.logger.i(TAG) {
        "Broadcasted ANR: pid=${exitInfo.pid}, process=${exitInfo.processName}"
      }
      true
    } catch (e: Exception) {
      AutoMobileSDK.logger.e(TAG, e) { "Failed to broadcast ANR" }
      false
    }
  }

  private fun getImportanceName(importance: Int): String =
    when (importance) {
      ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND -> "FOREGROUND"
      ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE -> "FOREGROUND_SERVICE"
      ActivityManager.RunningAppProcessInfo.IMPORTANCE_TOP_SLEEPING -> "TOP_SLEEPING"
      ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE -> "VISIBLE"
      ActivityManager.RunningAppProcessInfo.IMPORTANCE_PERCEPTIBLE -> "PERCEPTIBLE"
      ActivityManager.RunningAppProcessInfo.IMPORTANCE_PERCEPTIBLE_PRE_26 -> "PERCEPTIBLE_PRE_26"
      ActivityManager.RunningAppProcessInfo.IMPORTANCE_CANT_SAVE_STATE -> "CANT_SAVE_STATE"
      ActivityManager.RunningAppProcessInfo.IMPORTANCE_SERVICE -> "SERVICE"
      ActivityManager.RunningAppProcessInfo.IMPORTANCE_CACHED -> "CACHED"
      ActivityManager.RunningAppProcessInfo.IMPORTANCE_GONE -> "GONE"
      else -> "UNKNOWN"
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

  private fun getPrefs(context: Context): SharedPreferences {
    return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
  }

  private fun getLastReportedCursor(context: Context): AnrCursor {
    val prefs = getPrefs(context)
    val ids =
      if (prefs.contains(KEY_LAST_REPORTED_TIMESTAMP) && !prefs.contains(KEY_LAST_REPORTED_IDS)) {
        null
      } else {
        prefs.getStringSet(KEY_LAST_REPORTED_IDS, emptySet())?.toSet().orEmpty()
      }
    return AnrCursor(prefs.getLong(KEY_LAST_REPORTED_TIMESTAMP, 0L), ids)
  }

  private fun setLastReportedCursor(context: Context, cursor: AnrCursor) {
    getPrefs(context)
      .edit()
      .putLong(KEY_LAST_REPORTED_TIMESTAMP, cursor.timestamp)
      .putStringSet(KEY_LAST_REPORTED_IDS, cursor.idsAtTimestamp)
      .apply()
  }
}
