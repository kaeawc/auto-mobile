package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.mcp.DeviceResourceParser

/**
 * URI of the lightweight lock-state resource the host polls (issue #5056). Distinct from the full
 * `automobile:devices/booted` resource: it runs only the keyguard probe, not the per-device service
 * status the poll otherwise re-computed every cycle.
 */
const val DEVICE_LOCK_STATES_RESOURCE_URI = "automobile:devices/lockStates"

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
