package dev.jasonpearson.automobile.desktop.core.shell

import dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceIdentity
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceLifecycle
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceRuntime

/** The runtime ID the desktop selects and acts on, falling back to the source identity. */
internal val BootedDeviceInfo.deviceId: String
  get() = runtime.deviceId ?: identity.stableId

internal val BootedDeviceInfo.isIos: Boolean
  get() = platform == "ios"

/**
 * The source image this device was booted from, or null when the identity is unresolved. An
 * unresolved Android AVD probe reports a runtime label (the serial or `Unknown (<serial>)`), not a
 * source-image identity.
 */
internal fun BootedDeviceInfo.knownSourceImageId(): String? =
  identity.stableId.takeUnless {
    identityUnresolved || (!isIos && (it == deviceId || it == "Unknown ($deviceId)"))
  }

/**
 * Normalizes a daemon-reported device for the shell: the runtime ID is always present for selection
 * and actions, and an unresolved source identity falls back to that runtime ID and is marked
 * [BootedDeviceInfo.identityUnresolved].
 */
internal fun BootedDeviceInfo.forShell(): BootedDeviceInfo {
  val id = deviceId
  val sourceImageId = knownSourceImageId()
  return copy(
    identity = DeviceIdentity(sourceImageId ?: id),
    identityUnresolved = sourceImageId == null,
    runtime = runtime.copy(deviceId = id),
  )
}

/** A shell device built from runtime fields alone, for Fake mode and placeholder lists. */
internal fun shellBootedDevice(
  deviceId: String,
  name: String,
  platform: String,
  state: String = "booted",
  isVirtual: Boolean = true,
  stableId: String? = null,
): BootedDeviceInfo =
  BootedDeviceInfo(
      name = name,
      platform = platform,
      isVirtual = isVirtual,
      identity = DeviceIdentity(stableId ?: deviceId),
      runtime =
        DeviceRuntime(
          deviceId = deviceId,
          lifecycle = DeviceLifecycle(state = state, known = true),
        ),
    )
    .forShell()
