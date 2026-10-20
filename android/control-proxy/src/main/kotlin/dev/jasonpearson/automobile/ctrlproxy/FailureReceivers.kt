package dev.jasonpearson.automobile.ctrlproxy

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.sdk.crashes.AutoMobileCrashes
import dev.jasonpearson.automobile.sdk.failures.AutoMobileFailures
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

private const val TAG = "CtrlProxy"

/** A handled exception reported by the SDK, normalised from the protocol or legacy extras. */
internal data class HandledExceptionReport(
  val timestamp: Long,
  val exceptionClass: String,
  val exceptionMessage: String?,
  val stackTrace: String,
  val customMessage: String?,
  val currentScreen: String?,
  val packageName: String,
  val appVersion: String?,
  val deviceModel: String,
  val deviceManufacturer: String,
  val osVersion: String,
  val sdkInt: Int,
)

/** An app crash reported by the SDK, normalised from the protocol or legacy extras. */
internal data class CrashReport(
  val timestamp: Long,
  val exceptionClass: String,
  val exceptionMessage: String?,
  val stackTrace: String,
  val threadName: String,
  val currentScreen: String?,
  val packageName: String,
  val appVersion: String?,
  val deviceModel: String,
  val deviceManufacturer: String,
  val osVersion: String,
  val sdkInt: Int,
)

/** The service members the failure receivers need: the sinks that forward reports to clients. */
internal interface FailureReportHost {
  suspend fun onHandledException(report: HandledExceptionReport)

  suspend fun onCrash(report: CrashReport)
}

/** Receives handled-exception broadcasts and forwards them to [host] on [scope]. */
internal class HandledExceptionReceiver(
  private val scope: CoroutineScope,
  private val host: FailureReportHost,
) : BroadcastReceiver() {
  override fun onReceive(context: Context?, intent: Intent?) {
    if (intent == null || intent.action != AutoMobileFailures.ACTION_HANDLED_EXCEPTION) {
      return
    }

    val report =
      try {
        parse(intent) ?: return
      } catch (e: Exception) {
        Log.e(TAG, "Error handling handled exception broadcast", e)
        return
      }
    scope.launch { host.onHandledException(report) }
  }

  private fun parse(intent: Intent): HandledExceptionReport? {
    // Try type-safe deserialization first (new protocol)
    val eventJson = intent.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON)
    if (eventJson != null) {
      val event = SdkEventSerializer.handledExceptionEventFromJson(eventJson)
      if (event != null) {
        Log.d(
          TAG,
          "Received handled exception (protocol): ${event.exceptionClass} from ${event.applicationId}",
        )
        return HandledExceptionReport(
          timestamp = event.timestamp,
          exceptionClass = event.exceptionClass,
          exceptionMessage = event.exceptionMessage,
          stackTrace = event.stackTrace,
          customMessage = event.customMessage,
          currentScreen = event.currentScreen,
          packageName = event.applicationId ?: "unknown",
          appVersion = event.appVersion,
          deviceModel = event.deviceInfo?.model ?: "unknown",
          deviceManufacturer = event.deviceInfo?.manufacturer ?: "unknown",
          osVersion = event.deviceInfo?.osVersion ?: "unknown",
          sdkInt = event.deviceInfo?.sdkInt ?: 0,
        )
      }
    }

    // Fallback to legacy extras for backward compatibility
    val exceptionClass =
      intent.getStringExtra(AutoMobileFailures.EXTRA_EXCEPTION_CLASS) ?: return null
    val stackTrace = intent.getStringExtra(AutoMobileFailures.EXTRA_STACK_TRACE) ?: return null
    val packageName = intent.getStringExtra(AutoMobileFailures.EXTRA_PACKAGE_NAME) ?: return null
    Log.d(TAG, "Received handled exception (legacy): $exceptionClass from $packageName")
    return HandledExceptionReport(
      timestamp = intent.getLongExtra(AutoMobileFailures.EXTRA_TIMESTAMP, 0L),
      exceptionClass = exceptionClass,
      exceptionMessage = intent.getStringExtra(AutoMobileFailures.EXTRA_EXCEPTION_MESSAGE),
      stackTrace = stackTrace,
      customMessage = intent.getStringExtra(AutoMobileFailures.EXTRA_CUSTOM_MESSAGE),
      currentScreen = intent.getStringExtra(AutoMobileFailures.EXTRA_CURRENT_SCREEN),
      packageName = packageName,
      appVersion = intent.getStringExtra(AutoMobileFailures.EXTRA_APP_VERSION),
      deviceModel = intent.getStringExtra(AutoMobileFailures.EXTRA_DEVICE_MODEL) ?: "unknown",
      deviceManufacturer =
        intent.getStringExtra(AutoMobileFailures.EXTRA_DEVICE_MANUFACTURER) ?: "unknown",
      osVersion = intent.getStringExtra(AutoMobileFailures.EXTRA_OS_VERSION) ?: "unknown",
      sdkInt = intent.getIntExtra(AutoMobileFailures.EXTRA_SDK_INT, 0),
    )
  }
}

/** Receives crash broadcasts and forwards them to [host] on [scope]. */
internal class CrashReceiver(
  private val scope: CoroutineScope,
  private val host: FailureReportHost,
) : BroadcastReceiver() {
  override fun onReceive(context: Context?, intent: Intent?) {
    if (intent == null || intent.action != AutoMobileCrashes.ACTION_CRASH) {
      return
    }

    val report =
      try {
        parse(intent) ?: return
      } catch (e: Exception) {
        Log.e(TAG, "Error handling crash broadcast", e)
        return
      }
    scope.launch { host.onCrash(report) }
  }

  private fun parse(intent: Intent): CrashReport? {
    // Try type-safe deserialization first (new protocol)
    val eventJson = intent.getStringExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON)
    if (eventJson != null) {
      val event = SdkEventSerializer.crashEventFromJson(eventJson)
      if (event != null) {
        Log.d(
          TAG,
          "Received crash (protocol): ${event.exceptionClass} from ${event.applicationId}",
        )
        return CrashReport(
          timestamp = event.timestamp,
          exceptionClass = event.exceptionClass,
          exceptionMessage = event.exceptionMessage,
          stackTrace = event.stackTrace,
          threadName = event.threadName,
          currentScreen = event.currentScreen,
          packageName = event.applicationId ?: "unknown",
          appVersion = event.appVersion,
          deviceModel = event.deviceInfo?.model ?: "unknown",
          deviceManufacturer = event.deviceInfo?.manufacturer ?: "unknown",
          osVersion = event.deviceInfo?.osVersion ?: "unknown",
          sdkInt = event.deviceInfo?.sdkInt ?: 0,
        )
      }
    }

    return parseLegacyCrash(intent)
  }

  private fun parseLegacyCrash(intent: Intent): CrashReport? {
    // Fallback to legacy extras for backward compatibility
    val exceptionClass =
      intent.getStringExtra(AutoMobileCrashes.EXTRA_EXCEPTION_CLASS) ?: return null
    val stackTrace = intent.getStringExtra(AutoMobileCrashes.EXTRA_STACK_TRACE) ?: return null
    val packageName = intent.getStringExtra(AutoMobileCrashes.EXTRA_PACKAGE_NAME) ?: return null
    Log.d(TAG, "Received crash (legacy): $exceptionClass from $packageName")
    return CrashReport(
      timestamp = intent.getLongExtra(AutoMobileCrashes.EXTRA_TIMESTAMP, 0L),
      exceptionClass = exceptionClass,
      exceptionMessage = intent.getStringExtra(AutoMobileCrashes.EXTRA_EXCEPTION_MESSAGE),
      stackTrace = stackTrace,
      threadName = intent.getStringExtra(AutoMobileCrashes.EXTRA_THREAD_NAME) ?: "unknown",
      currentScreen = intent.getStringExtra(AutoMobileCrashes.EXTRA_CURRENT_SCREEN),
      packageName = packageName,
      appVersion = intent.getStringExtra(AutoMobileCrashes.EXTRA_APP_VERSION),
      deviceModel = intent.getStringExtra(AutoMobileCrashes.EXTRA_DEVICE_MODEL) ?: "unknown",
      deviceManufacturer =
        intent.getStringExtra(AutoMobileCrashes.EXTRA_DEVICE_MANUFACTURER) ?: "unknown",
      osVersion = intent.getStringExtra(AutoMobileCrashes.EXTRA_OS_VERSION) ?: "unknown",
      sdkInt = intent.getIntExtra(AutoMobileCrashes.EXTRA_SDK_INT, 0),
    )
  }
}
