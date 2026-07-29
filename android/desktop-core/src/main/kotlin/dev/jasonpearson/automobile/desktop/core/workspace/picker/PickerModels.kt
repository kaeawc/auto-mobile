package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceImageInfo
import dev.jasonpearson.automobile.desktop.core.workspace.Platform

/**
 * State of a device in the picker. A "booting" state is intentionally absent — the daemon device
 * resources do not model it (only booted vs available), so it is deferred to a follow-up.
 */
enum class DeviceState {
  Booted,
  Shutdown,
}

/**
 * A device row in the picker, unified from the booted-devices and device-images MCP resources. Only
 * booted devices can be observed in this PR.
 */
data class PickerDevice(
  val id: String,
  val name: String,
  val platform: Platform,
  val state: DeviceState,
  /** Normalized OS key for filtering/grouping: Android API level ("34") or iOS major ("17"). */
  val osKey: String? = null,
  /** Human label: "API 34" / "iOS 17". */
  val osLabel: String? = null,
  /** CPU architecture ("arm64"/"x86_64"); only iOS images currently carry it. */
  val architecture: String? = null,
)

private val ANDROID_TARGET = Regex("android-(\\d+)")
private val API_IN_NAME = Regex("API (\\d+)")

internal fun platformOf(raw: String): Platform =
  if (raw.equals("ios", ignoreCase = true)) Platform.Ios else Platform.Android

private fun androidApiFromName(name: String): String? =
  API_IN_NAME.find(name)?.groupValues?.getOrNull(1)

private fun osOfImage(image: DeviceImageInfo): Pair<String?, String?> =
  when {
    image.platform.equals("ios", ignoreCase = true) -> {
      val major = image.iosVersion?.substringBefore(".")?.takeIf { it.isNotBlank() }
      major to major?.let { "iOS $it" }
    }
    else -> {
      val api =
        ANDROID_TARGET.find(image.target ?: "")?.groupValues?.getOrNull(1)
          ?: androidApiFromName(image.name)
      api to api?.let { "API $it" }
    }
  }

/**
 * Merge the booted-devices and device-images resources into one picker list. Booted devices win
 * over their image entry (deduped by id and by name). Booted devices carry no OS/architecture from
 * the daemon today, so Android API is best-effort parsed from the name.
 */
fun buildPickerDevices(
  booted: List<BootedDeviceInfo>,
  images: List<DeviceImageInfo>,
): List<PickerDevice> {
  val bootedIds = booted.map { it.deviceId }.toSet()
  val bootedNames = booted.map { it.name }.toSet()

  val bootedDevices = booted.map { device ->
    val api =
      androidApiFromName(device.name).takeIf { platformOf(device.platform) == Platform.Android }
    PickerDevice(
      id = device.deviceId,
      name = device.name,
      platform = platformOf(device.platform),
      state = DeviceState.Booted,
      osKey = api,
      osLabel = api?.let { "API $it" },
      architecture = null,
    )
  }

  val shutdownDevices =
    images
      .filter { (it.deviceId ?: it.name) !in bootedIds && it.name !in bootedNames }
      .map { image ->
        val (osKey, osLabel) = osOfImage(image)
        PickerDevice(
          id = image.deviceId ?: image.name,
          name = image.name,
          platform = platformOf(image.platform),
          state = DeviceState.Shutdown,
          osKey = osKey,
          osLabel = osLabel,
          architecture = image.architecture,
        )
      }

  return (bootedDevices + shutdownDevices).distinctBy { it.id }
}
