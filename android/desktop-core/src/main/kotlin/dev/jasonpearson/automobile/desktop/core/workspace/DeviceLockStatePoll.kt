package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.mcp.DeviceResourceParser

/**
 * URI of the lightweight lock-state resource the host polls (issue #5056). Distinct from the full
 * `automobile:devices/booted` resource: it runs only the keyguard probe, not the per-device service
 * status the poll otherwise re-computed every cycle.
 */
const val DEVICE_LOCK_STATES_RESOURCE_URI = "automobile:devices/lockStates"

/**
 * URI of the full booted-devices resource. The poll falls back to this when a daemon does not
 * expose [DEVICE_LOCK_STATES_RESOURCE_URI] — an older server reached over a non-reconciling HTTP or
 * STDIO transport — since `automobile:devices/booted` also carries each device's `locked` flag.
 */
const val BOOTED_DEVICES_RESOURCE_URI = "automobile:devices/booted"

/**
 * Parse a lock-states resource payload into a `deviceId -> locked` snapshot for
 * [WorkspaceAction.SetLockStates]. Devices whose `locked` the daemon could not read are OMITTED
 * (the field is `null`), never coerced to `false` — so a device with an unknown lock state keeps
 * its pane's current state instead of being force-unlocked. A malformed/empty payload likewise
 * yields an empty map ("no update"). Pure so the host's untested poll stays a thin IO wrapper.
 */
fun parseDeviceLockStates(content: String): Map<String, Boolean> =
  DeviceResourceParser.parseLockStates(content)
    ?.lockStates
    ?.mapNotNull { state -> state.locked?.let { state.deviceId to it } }
    ?.toMap() ?: emptyMap()

/**
 * Fallback for older daemons that lack [DEVICE_LOCK_STATES_RESOURCE_URI]: derive the same `deviceId
 * -> locked` snapshot from the full `automobile:devices/booted` payload, whose
 * [dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo.locked] flag was added in #4694.
 * Same omit-when-unknown / empty-on-malformed contract as [parseDeviceLockStates].
 */
fun parseBootedLockStates(content: String): Map<String, Boolean> =
  DeviceResourceParser.parseBootedDevices(content)
    ?.devices
    ?.mapNotNull { device -> device.locked?.let { device.deviceId to it } }
    ?.toMap() ?: emptyMap()
