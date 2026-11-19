package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager

internal class AndroidBatteryStatusSource(context: Context) :
  PrototypeDeviceStatusSource by AndroidDeviceStatusSource(AndroidBatteryStatusGateway(context))

private class AndroidBatteryStatusGateway(private val context: Context) : AndroidStatusGateway {
  override fun read() =
    context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)).let { intent ->
      PrototypeDeviceStatus.battery(
        intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1,
        intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1,
        intent?.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)
          ?: BatteryManager.BATTERY_STATUS_UNKNOWN,
      )
    }

  override fun observe(changed: () -> Unit, retain: (() -> Unit) -> Unit) {
    observeStatusBroadcast(context, Intent.ACTION_BATTERY_CHANGED, changed, retain)
  }
}
