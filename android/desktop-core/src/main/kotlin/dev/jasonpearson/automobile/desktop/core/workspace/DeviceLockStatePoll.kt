package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.mcp.DeviceResourceParser

/** URI of the booted-devices resource that carries each device's lock state. */
const val BOOTED_DEVICES_RESOURCE_URI = "automobile:devices/booted"

/**
 * Parse a booted-devices resource payload into a `deviceId -> locked` snapshot for
 * [WorkspaceAction.SetLockStates]. Devices whose `locked` the daemon could not read are OMITTED
 * (the field is `null`), never coerced to `false` — so a device with an unknown lock state keeps
 * its pane's current state instead of being force-unlocked. A malformed/empty payload likewise
 * yields an empty map ("no update"). Pure so the host's untested poll stays a thin IO wrapper.
 */
fun parseDeviceLockStates(content: String): Map<String, Boolean> =
  DeviceResourceParser.parseBootedDevices(content)
    ?.devices
    ?.mapNotNull { device -> device.locked?.let { device.deviceId to it } }
    ?.toMap() ?: emptyMap()
