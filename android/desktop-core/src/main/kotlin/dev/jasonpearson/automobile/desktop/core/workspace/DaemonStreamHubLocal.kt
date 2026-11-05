package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.staticCompositionLocalOf
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonStreamHub
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamKey
import dev.jasonpearson.automobile.desktop.core.daemon.MultiplexedObservationSocketClient
import dev.jasonpearson.automobile.desktop.core.daemon.MultiplexedTelemetrySocketClient
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationHubConfig
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.SharedDaemonStreamHub

/**
 * The process-wide [DaemonStreamHub] facets draw device streams from. Null (the default, e.g. the
 * IDE plugin) keeps each facet's own per-pane connection.
 */
val LocalDaemonStreamHub = staticCompositionLocalOf<DaemonStreamHub?> { null }

/**
 * Remembers one [SharedDaemonStreamHub] for the composition's lifetime and closes it on dispose.
 * [sessionUuidProvider] is read at connect time, so registering the desktop session later needs no
 * new hub.
 */
@Composable
fun rememberDaemonStreamHub(sessionUuidProvider: () -> String?): DaemonStreamHub {
  val latestSessionUuidProvider by rememberUpdatedState(sessionUuidProvider)
  val observations = remember {
    // Every observed device's observation stream over one socket and one reader thread (#17011).
    MultiplexedObservationSocketClient.create({ latestSessionUuidProvider() })
  }
  val hub = remember {
    SharedDaemonStreamHub(
      // Every observed device's telemetry over one socket and one reader thread (#16968).
      telemetry = MultiplexedTelemetrySocketClient.create({ latestSessionUuidProvider() }),
      observation = ObservationHubConfig(streamFactory = observations::stream),
    )
  }
  DisposableEffect(hub) {
    onDispose {
      hub.close()
      observations.close()
    }
  }
  return hub
}

/**
 * The observation-stream factory a pane's facet should use for [column]: a lease on [hub]'s shared
 * per-device stream when the app has a hub, otherwise [fallback] (the facet's own per-pane stream).
 */
internal fun hubObservationFactory(
  hub: DaemonStreamHub?,
  column: DeviceColumn,
  fallback: () -> ObservationStream,
): () -> ObservationStream =
  hub?.let { { it.observationStream(DeviceStreamKey(column.deviceId, column.deviceSessionUuid)) } }
    ?: fallback

/**
 * A pane facet's observation stream for [column]: a lease on the app's [LocalDaemonStreamHub]
 * per-device stream when there is one, otherwise [fallback]'s own per-pane stream, with the
 * lifecycle of [rememberReconnectingObservationState]. A new device epoch takes a new lease, keyed
 * by the column's deviceSessionUuid.
 */
@Composable
internal fun rememberPaneObservationState(
  column: DeviceColumn,
  fallback: () -> ObservationStream,
  backoffDelay: suspend (attempt: Int) -> Unit,
  socketAvailable: () -> Boolean,
): ReconnectingObservationState {
  val hub = LocalDaemonStreamHub.current
  return key(column.deviceSessionUuid) {
    rememberReconnectingObservationState(
      ReconnectingObservationOptions(
        deviceId = column.deviceId,
        streamFactory = hubObservationFactory(hub, column, fallback),
        backoffDelay = backoffDelay,
        socketAvailable = socketAvailable,
      ),
    )
  }
}
