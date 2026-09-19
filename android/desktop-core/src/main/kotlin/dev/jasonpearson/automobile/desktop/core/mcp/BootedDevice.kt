package dev.jasonpearson.automobile.desktop.core.mcp

/** Device types for booted device representation. */
enum class DeviceType {
  AndroidEmulator,
  AndroidPhysical,
  iOSSimulator,
  iOSPhysical,
}

/** Represents a booted device available for test execution. */
data class BootedDevice(
  val id: String,
  val name: String,
  val type: DeviceType,
  val status: String = "Running",
  val foregroundApp: String? = null,
  val connectedAt: Long = System.currentTimeMillis(),
  val stableId: String? = null,
)

/** An unresolved Android AVD probe reports a runtime label, not a source-image identity. */
internal fun BootedDevice.knownSourceImageId(): String? = stableId?.takeUnless {
  (type == DeviceType.AndroidEmulator || type == DeviceType.AndroidPhysical) &&
    (it == id || it == "Unknown ($id)")
}

/** Available emulator/simulator that can be booted. */
data class AvailableEmulator(
  val id: String,
  val name: String,
  val type: DeviceType,
  val apiLevel: String? = null,
)

/** System image that can be used to create an emulator. */
data class SystemImage(
  val id: String,
  val name: String,
  val platform: String, // "Android" or "iOS"
  val apiLevel: String,
)
