package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.connection.ConnectionState
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonStreamHub
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamKey
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf

/**
 * Per-device stream health for the workspace status dot (#4857): one [ConnectionState] per observed
 * column whose device has a live stream on [this] hub, the worst of its telemetry and observation
 * connections. A column with no open stream (no facet showing it) is left out rather than counted
 * as offline, since the hub keeps no connection for it; no status-only stream is opened.
 */
@OptIn(ExperimentalCoroutinesApi::class)
fun DaemonStreamHub.deviceStreamHealth(columns: List<DeviceColumn>): Flow<List<ConnectionState>> {
  val keys = columns.map { DeviceStreamKey(it.deviceId, it.deviceSessionUuid) }
  return combine(subscriptions, observationSubscriptions) { telemetry, observation ->
      keys.map { key ->
        listOfNotNull(
          if (key in telemetry) telemetryConnectionState(key) else null,
          if (key in observation) observationConnectionState(key) else null,
        )
      }
    }
    .distinctUntilChanged()
    .flatMapLatest { perDevice ->
      val streams = perDevice.filter { it.isNotEmpty() }
      if (streams.isEmpty()) flowOf(emptyList())
      else
        combine(streams.map { states -> combine(states) { worstOf(it.toList()) } }) { it.toList() }
    }
    .distinctUntilChanged()
}

/** The least healthy of [states]: offline, then (re)connecting, then connected. */
internal fun worstOf(states: List<ConnectionState>): ConnectionState = states.maxBy {
  healthRank(it)
}

private fun healthRank(state: ConnectionState): Int =
  when (state) {
    is ConnectionState.Connected -> 0
    is ConnectionState.Connecting,
    is ConnectionState.Reconnecting -> 1
    is ConnectionState.Disconnected,
    is ConnectionState.Error -> 2
  }
