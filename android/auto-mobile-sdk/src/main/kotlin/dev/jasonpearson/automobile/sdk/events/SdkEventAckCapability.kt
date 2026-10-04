package dev.jasonpearson.automobile.sdk.events

import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import dev.jasonpearson.automobile.protocol.SdkEventBatchBroadcastContract
import dev.jasonpearson.automobile.sdk.SdkConstants
import dev.jasonpearson.automobile.sdk.logging.DefaultSdkLogger

/** Package visibility is owned by the host; failure to query preserves legacy delivery. */
internal fun interface AckPackageInfoReader {
  fun supportsAcknowledgment(): Boolean
}

internal class AndroidAckPackageInfoReader(private val packageManager: PackageManager) :
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
      SdkEventBatchBroadcastContract.META_DATA_ACK_SUPPORTED,
      false,
    ) == true
  }
}

internal class SdkEventAckCapability(
  private val reader: AckPackageInfoReader,
  private val clock: () -> Long = SystemClock::elapsedRealtime,
  private val refreshIntervalMs: Long = 30_000,
) {
  private val logger = DefaultSdkLogger()
  private var checkedAt: Long? = null
  private var supported = false

  @Synchronized
  fun isSupported(): Boolean {
    val now = clock()
    val previous = checkedAt
    if (previous != null && now - previous in 0 until refreshIntervalMs) return supported
    supported =
      try {
        reader.supportsAcknowledgment().also { checkedAt = now }
      } catch (error: PackageManager.NameNotFoundException) {
        // Missing or invisible packages are expected; retry on the next send after installation.
        logger.d("SdkEventAckCapability") { "CtrlProxy is not visible: ${error.message}" }
        checkedAt = null
        false
      } catch (error: Exception) {
        logger.w("SdkEventAckCapability", error) { "Could not read CtrlProxy acknowledgment flag" }
        checkedAt = now
        false
      }
    return supported
  }
}
