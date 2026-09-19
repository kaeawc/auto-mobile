package dev.jasonpearson.automobile.desktop.core.mcp

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Response from automobile:devices/booted resource */
@Serializable
data class BootedDevicesResponse(
  val totalCount: Int,
  val androidCount: Int,
  val iosCount: Int,
  val virtualCount: Int,
  val physicalCount: Int,
  val lastUpdated: String,
  val devices: List<BootedDeviceInfo>,
  val observationComplete: Boolean = true,
  val platformObservations: Map<String, DevicePlatformObservation> = emptyMap(),
  val sourceObservations: Map<String, DevicePlatformObservation> = emptyMap(),
)

@Serializable data class DevicePlatformObservation(val observationComplete: Boolean = false)

@Serializable data class DeviceIdentity(val stableId: String)

@Serializable
data class DeviceLifecycle(
  val state: String,
  val known: Boolean,
)

@Serializable data class DeviceReadiness(val state: String = "unknown")

@Serializable
data class DeviceSession(
  val sessionUuid: String? = null,
  val ownership: String? = null,
)

@Serializable
data class DeviceDisplay(
  val width: Int? = null,
  val height: Int? = null,
  val density: Double? = null,
)

@Serializable
data class DeviceImage(
  val path: String? = null,
  val target: String? = null,
  val basedOn: String? = null,
)

@Serializable
data class DeviceCapability(
  val id: String,
  val state: String,
  val reason: String? = null,
  val source: String? = null,
)

@Serializable
data class DeviceCapabilityInventory(
  val schemaVersion: Int,
  val capabilities: List<DeviceCapability>,
)

@Serializable
data class DeviceRuntime(
  val deviceId: String? = null,
  // Key for one connection epoch of the device: `<deviceId>#<incarnation>` when the daemon's pool
  // knows the incarnation, otherwise the bare serial, which carries no epoch information.
  val connectionId: String? = null,
  val deviceSessionUuid: String? = null,
  val lifecycle: DeviceLifecycle,
  val readiness: DeviceReadiness = DeviceReadiness(),
  val poolStatus: String? = null,
  val session: DeviceSession? = null,
  val serviceStatus: DeviceServiceStatus? = null,
  val locked: Boolean? = null,
  val orientation: String? = null,
)

@Serializable
data class DeviceServiceStatus(
  val installed: Boolean = false,
  val enabled: Boolean = false,
  val running: Boolean = false,
  val installedSha256: String? = null,
  val expectedSha256: String = "",
  val isCompatible: Boolean = true,
)

@Serializable
data class BootedDeviceInfo(
  val name: String,
  val platform: String, // "android" or "ios"
  val isVirtual: Boolean = true,
  val source: String? = null, // "local" or "remote"
  val identity: DeviceIdentity,
  val formFactor: String = "unknown",
  val deviceType: String? = null,
  val model: String? = null,
  val architecture: String? = null,
  val osVersion: String? = null,
  val apiLevel: Int? = null,
  val runtimeId: String? = null,
  val display: DeviceDisplay = DeviceDisplay(),
  val capabilityInventory: DeviceCapabilityInventory? = null,
  val image: DeviceImage = DeviceImage(),
  val availabilityError: String? = null,
  val runtime: DeviceRuntime,
  // Resource-specific diagnostic siblings outside the canonical description.
  val serviceStatus: DeviceServiceStatus? = null,
  val locked: Boolean? = null,
  val identityUnresolved: Boolean = false,
)

@Serializable
data class ServiceExpectedInfo(
  val expectedSha256: String = "",
  val url: String = "",
  val expectedAppHash: String = "",
)

@Serializable
data class DaemonPlatformInfo(
  val ctrlProxy: ServiceExpectedInfo? = null,
  val xcTestService: ServiceExpectedInfo? = null,
)

@Serializable
data class DaemonStatusResponse(
  val version: String = "",
  val releaseVersion: String = "",
  val android: DaemonPlatformInfo? = null,
  val ios: DaemonPlatformInfo? = null,
)

/** Response from automobile:devices/images resource */
@Serializable
data class DeviceImagesResponse(
  val totalCount: Int,
  val androidCount: Int,
  val iosCount: Int,
  val lastUpdated: String,
  val images: List<DeviceImageInfo>,
)

@Serializable
data class DeviceImageInfo(
  val name: String,
  val platform: String, // "android" or "ios"
  val isVirtual: Boolean = true,
  val source: String? = null,
  val identity: DeviceIdentity,
  val formFactor: String = "unknown",
  val deviceType: String? = null,
  val model: String? = null,
  val architecture: String? = null,
  val osVersion: String? = null,
  val apiLevel: Int? = null,
  val runtimeId: String? = null,
  val display: DeviceDisplay = DeviceDisplay(),
  val capabilityInventory: DeviceCapabilityInventory? = null,
  val image: DeviceImage = DeviceImage(),
  val availabilityError: String? = null,
  val runtime: DeviceRuntime,
)

/** Response from the lightweight automobile:devices/lockStates resource (issue #5056). */
@Serializable
data class DeviceLockStatesResponse(
  val lastUpdated: String = "",
  val lockStates: List<DeviceLockStateInfo> = emptyList(),
)

@Serializable
data class DeviceLockStateInfo(
  val deviceId: String,
  // Android keyguard state; omitted (null) when the daemon couldn't read it, or on iOS.
  val locked: Boolean? = null,
)

/** Parser for device resource responses */
object DeviceResourceParser {
  private val json = Json {
    ignoreUnknownKeys = true
    isLenient = true
  }

  fun parseBootedDevices(jsonString: String): BootedDevicesResponse? {
    return try {
      json.decodeFromString<BootedDevicesResponse>(jsonString)
    } catch (e: Exception) {
      null
    }
  }

  fun parseDeviceImages(jsonString: String): DeviceImagesResponse? {
    return try {
      json.decodeFromString<DeviceImagesResponse>(jsonString)
    } catch (e: Exception) {
      null
    }
  }

  fun parseLockStates(jsonString: String): DeviceLockStatesResponse? {
    return try {
      json.decodeFromString<DeviceLockStatesResponse>(jsonString)
    } catch (e: Exception) {
      null
    }
  }
}
