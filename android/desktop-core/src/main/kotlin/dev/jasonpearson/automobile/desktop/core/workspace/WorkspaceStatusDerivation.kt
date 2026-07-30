package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState

/**
 * Outcome of rolling up connection health into the top-bar status dot: the [WorkspaceStatus] color
 * and a terse [detail] line shown inline for a non-green status ("yellow = one line"). [detail] is
 * null for [WorkspaceStatus.Green], which renders a bare dot.
 */
data class WorkspaceStatusResult(
  val status: WorkspaceStatus,
  val detail: String?,
)

/**
 * Pure roll-up of live connection health into the workspace status dot. Data in, data out — no
 * Compose, no I/O — so the whole mapping is unit-testable with plain values.
 *
 * Priority: the daemon dominates. If the MCP daemon connection is down or errored the workspace is
 * [WorkspaceStatus.Red] regardless of device health, because without the daemon nothing else can be
 * trusted. A daemon that is mid-(re)connect is [WorkspaceStatus.Yellow]. Only once the daemon is
 * [ConnectionState.Connected] do per-device streams decide the color: any offline or (re)connecting
 * device stream is [WorkspaceStatus.Yellow]; all-connected is [WorkspaceStatus.Green].
 */
fun deriveWorkspaceStatus(
  daemon: ConnectionState,
  devices: List<ConnectionState>,
): WorkspaceStatusResult =
  when (daemon) {
    is ConnectionState.Disconnected ->
      WorkspaceStatusResult(WorkspaceStatus.Red, "Daemon disconnected")
    is ConnectionState.Error -> WorkspaceStatusResult(WorkspaceStatus.Red, "Daemon error")
    is ConnectionState.Connecting ->
      WorkspaceStatusResult(WorkspaceStatus.Yellow, "Daemon connecting")
    is ConnectionState.Reconnecting ->
      WorkspaceStatusResult(WorkspaceStatus.Yellow, "Daemon reconnecting")
    // Daemon is up: device streams decide the color.
    is ConnectionState.Connected -> deriveFromDevices(devices)
  }

/**
 * Roll up per-device stream health once the daemon is connected. Offline (disconnected/errored)
 * streams take wording priority over mid-(re)connect ones, since offline is the more actionable
 * problem; either keeps the workspace [WorkspaceStatus.Yellow].
 */
private fun deriveFromDevices(devices: List<ConnectionState>): WorkspaceStatusResult {
  val offline = devices.count { it is ConnectionState.Disconnected || it is ConnectionState.Error }
  val reconnecting = devices.count {
    it is ConnectionState.Connecting || it is ConnectionState.Reconnecting
  }
  return when {
    offline > 0 -> WorkspaceStatusResult(WorkspaceStatus.Yellow, devicePhrase(offline, "offline"))
    reconnecting > 0 ->
      WorkspaceStatusResult(WorkspaceStatus.Yellow, devicePhrase(reconnecting, "reconnecting"))
    else -> WorkspaceStatusResult(WorkspaceStatus.Green, null)
  }
}

/** Terse "N device(s) <adjective>" line with singular/plural agreement. */
private fun devicePhrase(count: Int, adjective: String): String =
  "$count device${if (count == 1) "" else "s"} $adjective"
