package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.os.Build
import android.os.PowerManager

internal class AndroidPowerStatusSource(context: Context) :
  PrototypeDeviceStatusSource by AndroidDeviceStatusSource(AndroidPowerStatusGateway(context))

private class AndroidPowerStatusGateway(private val context: Context) : AndroidStatusGateway {
  private val manager by lazy { context.getSystemService(PowerManager::class.java) }

  override fun read() =
    PrototypeDeviceStatus.power(
      manager.isPowerSaveMode,
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) manager.currentThermalStatus else null,
    )

  override fun observe(changed: () -> Unit, retain: (() -> Unit) -> Unit) {
    observeStatusBroadcast(context, PowerManager.ACTION_POWER_SAVE_MODE_CHANGED, changed, retain)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val listener = PowerManager.OnThermalStatusChangedListener { changed() }
      manager.addThermalStatusListener(listener)
      retain { manager.removeThermalStatusListener(listener) }
    }
  }
}
