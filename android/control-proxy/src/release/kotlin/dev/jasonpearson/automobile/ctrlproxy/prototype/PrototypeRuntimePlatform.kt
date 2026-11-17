package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import dev.jasonpearson.automobile.prototype.*

/**
 * Haptics, sound, the clipboard, connectivity, outbound links and settings deep links need no
 * runtime permission the overlay would have to request.
 */
internal fun prototypeRuntimePlatform(
  context: Context,
  clipboard: PrototypeClipboard? = null,
): PrototypePlatform =
  PrototypePlatform(
    prototypeFeedbackModules(context) +
      listOfNotNull(clipboard?.let { PrototypeClipboardModule(it) }) +
      PrototypeConnectivityModule(AndroidConnectivitySource(context)) +
      PrototypeDeviceStatusModule(DeviceStatusKind.BATTERY, AndroidBatteryStatusSource(context)) +
      PrototypeDeviceStatusModule(DeviceStatusKind.POWER, AndroidPowerStatusSource(context)) +
      PrototypeDeviceStatusModule(DeviceStatusKind.AUDIO, AndroidAudioStatusSource(context)) +
      PrototypeLinksModule(AndroidUrlOpener(SystemLinkGateway(context))) +
      PrototypeSettingsModule(AndroidSettingsOpener(SystemSettingsGateway(context))),
  )
