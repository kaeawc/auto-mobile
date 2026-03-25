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
)
