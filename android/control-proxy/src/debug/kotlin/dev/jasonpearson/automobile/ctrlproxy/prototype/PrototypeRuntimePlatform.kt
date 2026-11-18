package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
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
      PrototypeLocationModule(AndroidLocationSource(context)) +
      PrototypeSensorsModule(AndroidSensorSource(context)) +
      PrototypeConnectivityModule(AndroidConnectivitySource(context)) +
      PrototypeDeviceStatusModule(DeviceStatusKind.BATTERY, AndroidBatteryStatusSource(context)) +
      PrototypeDeviceStatusModule(DeviceStatusKind.POWER, AndroidPowerStatusSource(context)) +
      PrototypeDeviceStatusModule(DeviceStatusKind.AUDIO, AndroidAudioStatusSource(context)) +
      PrototypeLinksModule(AndroidUrlOpener(SystemLinkGateway(context))) +
      PrototypeSettingsModule(AndroidSettingsOpener(SystemSettingsGateway(context))),
  )
