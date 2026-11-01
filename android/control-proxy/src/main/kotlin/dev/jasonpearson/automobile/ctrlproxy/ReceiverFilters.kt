package dev.jasonpearson.automobile.ctrlproxy

import android.content.Intent
import android.content.IntentFilter
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.anr.AutoMobileAnr
import dev.jasonpearson.automobile.sdk.crashes.AutoMobileCrashes
import dev.jasonpearson.automobile.sdk.failures.AutoMobileFailures

/** The broadcasts each of the service's exported receivers listens for. */
internal object ReceiverFilters {
  /** The daemon's ADB command broadcasts. */
  fun command() = IntentFilter(CtrlProxy.ACTION_EXTRACT_HIERARCHY)

  fun navigation() = IntentFilter(AutoMobileSDK.ACTION_NAVIGATION_EVENT)

  fun eventBatch() = IntentFilter(SdkEventSerializer.ACTION_SDK_EVENT_BATCH)

  fun recomposition() = IntentFilter(AutoMobileSDK.ACTION_RECOMPOSITION_SNAPSHOT)

  /** Frame-metrics snapshots (issue #5076). */
  fun frameMetrics() = IntentFilter(AutoMobileSDK.ACTION_FRAME_METRICS_SNAPSHOT)

  fun packages() =
    IntentFilter().apply {
      addAction(Intent.ACTION_PACKAGE_ADDED)
      addAction(Intent.ACTION_PACKAGE_REMOVED)
      addAction(Intent.ACTION_PACKAGE_REPLACED)
      addDataScheme("package")
    }

  fun handledException() = IntentFilter(AutoMobileFailures.ACTION_HANDLED_EXCEPTION)

  fun crash() = IntentFilter(AutoMobileCrashes.ACTION_CRASH)

  fun anr() = IntentFilter(AutoMobileAnr.ACTION_ANR)
}
