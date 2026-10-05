package dev.jasonpearson.automobile.sdk.anr

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.annotation.RequiresApi
import dev.jasonpearson.automobile.protocol.SdkAnrEvent
import dev.jasonpearson.automobile.protocol.SdkDeviceInfo
import dev.jasonpearson.automobile.protocol.SdkEventBatchBroadcastContract
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.SdkConstants
import dev.jasonpearson.automobile.sdk.events.AckPackageInfoReader
import dev.jasonpearson.automobile.sdk.events.BatchDeliveryScheduler
import dev.jasonpearson.automobile.sdk.events.SdkEventAckCapability
import dev.jasonpearson.automobile.sdk.events.SdkEventBroadcaster
import java.io.InputStream
import java.util.concurrent.ForkJoinPool
import java.util.concurrent.atomic.AtomicBoolean

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

  private var session: AnrReportingSession? = null
  // Private seams avoid adding JVM members to the public SDK signature.
  private var capabilityGate: SdkEventAckCapability? = null
  private var deliveryScheduler: BatchDeliveryScheduler? = null

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
  fun initialize(context: Context): Unit =
    synchronized(this) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
        AutoMobileSDK.logger.d(TAG) { "ANR detection requires Android 11+ (API 30)" }
        return
      }

      if (session?.isFinished == false) return
      val ctx = context.applicationContext
      val gate =
        capabilityGate ?: SdkEventAckCapability(AndroidAnrAckPackageInfoReader(ctx.packageManager))
      AutoMobileSDK.logger.d(TAG) { "AutoMobileAnr initialized, checking for previous ANRs..." }
      val reporting = AnrReportingSession(ctx, gate.isSupported(), deliveryScheduler)
      session = reporting
      reporting.start()
    }

  /** Check if ANR detection is available on this device. */
  fun isAvailable(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R

  /** Clears the retained application context during SDK shutdown or a failed initialization. */
  internal fun reset() =
    synchronized(this) {
      session?.close()
      session = null
      capabilityGate = null
      deliveryScheduler = null
    }

  // Keep this reader private: the javap API baseline also includes Kotlin internal classes.
  // The batch reader's constructor and metadata key must retain their existing contract.
  private class AndroidAnrAckPackageInfoReader(private val packageManager: PackageManager) :
    AckPackageInfoReader {
    override fun supportsAcknowledgment(): Boolean {
      val info =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          packageManager.getApplicationInfo(
            SdkConstants.CTRL_PROXY_PACKAGE,
            PackageManager.ApplicationInfoFlags.of(PackageManager.GET_META_DATA.toLong()),
          )
        } else {
          @Suppress("DEPRECATION")
          packageManager.getApplicationInfo(
            SdkConstants.CTRL_PROXY_PACKAGE,
            PackageManager.GET_META_DATA,
          )
        }
      return info.metaData?.getBoolean(
        "dev.jasonpearson.automobile.ctrlproxy.SDK_ANR_ACK_SUPPORTED",
        false,
      ) == true
    }
  }

  // Private pure seams keep the javap-based public API signature unchanged.
  @Suppress("NOTHING_TO_INLINE")
  private inline fun readCappedAnrTrace(stream: InputStream?, maxChars: Int): String? {
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

  // Keep callbacks and persistence on a private class: lambdas must not generate public
  // accessors for AutoMobileAnr's private members (the SDK API check uses javap).
  @RequiresApi(Build.VERSION_CODES.R)
  private class AnrReportingSession(
    private val context: Context,
    private val requireAck: Boolean,
    injectedScheduler: BatchDeliveryScheduler?,
  ) {
    private val handler = Handler(Looper.getMainLooper())
    private val scheduler =
      injectedScheduler
        ?: SdkEventBroadcaster.deliveryScheduler
        ?: object : BatchDeliveryScheduler {
          override fun schedule(task: Runnable, delayMs: Long): (() -> Unit)? {
            if (!handler.postDelayed(task, delayMs)) return null
            return { handler.removeCallbacks(task) }
          }

          override fun execute(task: Runnable) {
            // Direct initialization can precede the SDK buffer. Reuse the runtime's shared
            // workers rather than creating another pool or building traces on the main looper.
            ForkJoinPool.commonPool().execute(task)
          }
        }
    private var pending = emptyList<ApplicationExitInfo>()
    private var cursor = AnrCursor(0L, emptySet())
    private var cancelTimeout: (() -> Unit)? = null
    var isFinished = false
      @Synchronized get
      private set

    @Synchronized
    fun close() {
      isFinished = true
      pending = emptyList()
      cancelTimeout?.invoke()
      cancelTimeout = null
    }

    fun start() {
      try {
        scheduler.execute(Runnable { scan() })
      } catch (error: Exception) {
        AutoMobileSDK.logger.w(TAG, error) { "Could not dispatch ANR scan" }
        close()
      }
    }

    @Synchronized
    private fun scan() {
      if (isFinished) return
      try {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        if (am == null) {
          AutoMobileSDK.logger.w(TAG) { "ActivityManager not available" }
          close()
          return
        }
        val exitInfos = am.getHistoricalProcessExitReasons(null, 0, MAX_EXIT_REASONS)
        AutoMobileSDK.logger.d(TAG) { "Found ${exitInfos.size} historical exit reasons" }
        cursor = getLastReportedCursor(context)
        AutoMobileSDK.logger.d(TAG) { "Last reported ANR timestamp: ${cursor.timestamp}" }
        val anrInfos = exitInfos.filter { it.reason == ApplicationExitInfo.REASON_ANR }
        AutoMobileSDK.logger.d(TAG) { "Found ${anrInfos.size} ANR(s) in exit history" }
        pending = anrInfos.take(MAX_EXIT_REASONS).sortedBy { it.timestamp }
        reportNext()
      } catch (error: Exception) {
        AutoMobileSDK.logger.e(TAG, error) { "Error checking for previous ANRs" }
        close()
      }
    }

    // Exactly one ANR is in flight. The next one is sent only after this one's consumed
    // cursor is persisted. Invalid payloads are consumed; transient failures stop this scan.
    @Synchronized
    private fun reportNext() {
      if (isFinished) return
      while (pending.isNotEmpty()) {
        val item = pending.first()
        pending = pending.drop(1)
        val identity = "${item.pid}:${item.processName.length}:${item.processName}"
        val timestamp = item.timestamp
        if (
          timestamp < cursor.timestamp ||
            (timestamp == cursor.timestamp &&
              (cursor.idsAtTimestamp == null || identity in cursor.idsAtTimestamp.orEmpty()))
        ) {
          AutoMobileSDK.logger.d(TAG) {
            "Skipping already reported ANR: time=$timestamp, identity=$identity"
          }
          continue
        }
        AutoMobileSDK.logger.d(TAG) {
          "Detected NEW previous ANR: pid=${item.pid}, time=$timestamp"
        }
        broadcastAnr(item, identity)
        return
      }
      close()
    }

    @Synchronized
    private fun complete(item: ApplicationExitInfo, identity: String, consumed: Boolean) {
      if (isFinished) return
      cancelTimeout?.invoke()
      cancelTimeout = null
      if (!consumed) {
        close()
        return
      }
      try {
        cursor = reportNewAnrs(listOf(item), { it.timestamp }, { identity }, cursor) { true }
        // Serialized with reset and all callbacks, and both cursor fields share one editor.
        setLastReportedCursor(context, cursor)
        AutoMobileSDK.logger.d(TAG) { "Updated last reported timestamp to ${cursor.timestamp}" }
        reportNext()
      } catch (error: Exception) {
        AutoMobileSDK.logger.e(TAG, error) { "Failed to persist consumed ANR" }
        close()
      }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun broadcastAnr(exitInfo: ApplicationExitInfo, identity: String) {
      val resolved = AtomicBoolean(false)
      fun finish(consumed: Boolean) {
        if (resolved.compareAndSet(false, true)) {
          try {
            scheduler.execute(Runnable { complete(exitInfo, identity, consumed) })
          } catch (error: Exception) {
            AutoMobileSDK.logger.w(TAG, error) { "Could not dispatch ANR delivery result" }
            close()
          }
        }
      }
      try {
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

        if (!requireAck) {
          context.sendBroadcast(intent)
          complete(exitInfo, identity, true)
          return
        }
        // Stable across app starts; package and timestamp distinguish senders and sessions.
        intent.putExtra(
          SdkEventBatchBroadcastContract.EXTRA_BATCH_ID,
          "anr:${context.packageName.length}:${context.packageName}:${exitInfo.timestamp}:$identity",
        )
        cancelTimeout =
          scheduler.schedule(Runnable { finish(false) }, SdkEventBroadcaster.ACK_TIMEOUT_MS)
        val resultReceiver =
          object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
              val consumed =
                when (resultCode) {
                  SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED -> true
                  SdkEventBatchBroadcastContract.RESULT_BATCH_REJECTED_INVALID_PAYLOAD -> {
                    AutoMobileSDK.logger.w(TAG) {
                      "Consuming permanently invalid ANR: pid=${exitInfo.pid}, time=${exitInfo.timestamp}"
                    }
                    true
                  }
                  else -> false
                }
              finish(consumed)
            }
          }
        context.sendOrderedBroadcast(intent, null, resultReceiver, handler, 0, null, null)
        if (cancelTimeout == null) finish(false)
      } catch (e: Exception) {
        AutoMobileSDK.logger.e(TAG, e) { "Failed to broadcast ANR" }
        if (requireAck) finish(false) else complete(exitInfo, identity, false)
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
}
