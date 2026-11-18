package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.app.Activity
import android.content.Context
import androidx.activity.ComponentActivity
import dev.jasonpearson.automobile.prototype.*

/**
 * The haptics, sound, connectivity, links and settings modules, the clipboard, and the contract
 * test module debug builds carry.
 */
internal fun prototypeRuntimePlatform(
  context: Context,
  clipboard: PrototypeClipboard? = null,
): PrototypePlatform =
  PrototypePlatform(
    prototypeFeedbackModules(context) +
      listOfNotNull(TestPlatformModule(), clipboard?.let { PrototypeClipboardModule(it) }) +
      listOfNotNull(
        (context as? Activity)?.let { PrototypeBiometricModule(AndroidBiometricSource(it)) },
        (context as? ComponentActivity)?.let {
          PrototypePermissionsModule(AndroidPermissionsSource(it))
        },
      ) +
      PrototypeLocationModule(AndroidLocationSource(context)) +
      PrototypeSensorsModule(AndroidSensorSource(context)) +
      PrototypeConnectivityModule(AndroidConnectivitySource(context)) +
      PrototypeDeviceStatusModule(DeviceStatusKind.BATTERY, AndroidBatteryStatusSource(context)) +
      PrototypeDeviceStatusModule(DeviceStatusKind.POWER, AndroidPowerStatusSource(context)) +
      PrototypeDeviceStatusModule(DeviceStatusKind.AUDIO, AndroidAudioStatusSource(context)) +
      PrototypeLinksModule(AndroidUrlOpener(SystemLinkGateway(context))) +
      PrototypeSettingsModule(AndroidSettingsOpener(SystemSettingsGateway(context))),
  )
