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
  /** Whether the booted device's keyguard is up (from the booted resource). Shutdown -> false. */
  val locked: Boolean = false,
  /** Whether the device is virtual; shutdown images are simulator/emulator definitions. */
  val isVirtual: Boolean = true,
  /** Daemon-minted identity for the booted device epoch; absent on older daemon resources. */
  val deviceSessionUuid: String? = null,
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
 * Merge the booted-devices and device-images resources into one picker list. A booted device wins
 * over the specific image it came from, reconciled by IDENTITY, not display name:
 * - an image is hidden when its own id is booted (exact match — e.g. iOS simulators keep their UDID
 *   across boot); or
 * - when [sourceImageToRuntimeId] attributes a booted runtime id to that exact source image (an
 *   in-session boot: `BootDevice(sourceImageId)` -> `StartDeviceResult.deviceId`), so re-keyed
 *   devices hide their EXACT source, never a positional same-name guess; or
 * - as a FALLBACK for a booted VIRTUAL device not attributed in-session (already-running /
 *   externally booted) that the daemon re-keyed off its image id — one same-named image per such
 *   device, not all same-named images.
 *
 * Physical devices are not re-keyed, so they dedup by exact id only and never hide a distinct
 * same-named shut-down image. This keeps devices that merely share a display name (common for
 * simulators) from vanishing when a sibling boots. Booted devices carry no OS/architecture from the
 * daemon today, so Android API is best-effort parsed from the name.
 */
fun buildPickerDevices(
  booted: List<BootedDeviceInfo>,
  images: List<DeviceImageInfo>,
  sourceImageToRuntimeId: Map<String, String> = emptyMap(),
): List<PickerDevice> {
  val bootedIds = booted.map { it.deviceId }.toSet()
  val imageIds = images.map { it.deviceId ?: it.name }.toSet()
  val runtimeToSourceImage =
    sourceImageToRuntimeId.entries.associate { (source, rt) -> rt to source }

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
      // Seed value only; an unknown (null) lock state seeds unlocked and the host poll refines it.
      locked = device.locked == true,
      isVirtual = device.isVirtual,
      deviceSessionUuid = device.deviceSessionUuid,
    )
  }

  // Exact source images hidden via in-session boot attribution (runtime id -> its source image id).
  val attributedSourceIds = booted.mapNotNull { runtimeToSourceImage[it.deviceId] }.toSet()

  // Fallback name heuristic ONLY for re-keyed VIRTUAL devices with no in-session attribution
  // (already-running / externally booted): each hides exactly one same-named image, not all.
  // Physical devices are excluded — they are not re-keyed and must not hide a distinct sibling.
  val hideByName =
    booted
      .filter {
        it.isVirtual && it.deviceId !in imageIds && it.deviceId !in runtimeToSourceImage
      }
      .groupingBy { it.name }
      .eachCount()

  val shutdownDevices =
    images
      .filter { (it.deviceId ?: it.name) !in bootedIds } // exact identity already booted
      .filter { (it.deviceId ?: it.name) !in attributedSourceIds } // exact in-session source
      .groupBy { it.name }
      .flatMap { (name, sameName) -> sameName.drop(hideByName[name] ?: 0) }
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
