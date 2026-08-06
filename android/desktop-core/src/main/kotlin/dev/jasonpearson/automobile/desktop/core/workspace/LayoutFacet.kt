package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.layout.LayoutInspectorDashboard
import kotlinx.coroutines.delay

/**
 * Docked-facet body for the Layout Inspector, scoped to a single pane's device. An
 * [ObservationStream] is created via [observationStreamFactory] and connected to [column]'s device
 * while the facet is shown, then disposed when it leaves composition or the device changes — the
 * same per-device connect/dispose lifecycle as [LogsFacet]. Each pane therefore drives its own
 * stream and mirror, rather than following the app's active device.
 *
 * [observationStreamFactory] is injected (defaulting to a real per-device
 * [ObservationStreamClient]) so the connect/dispose lifecycle can be verified with a
 * [FakeObservationStream] instead of real socket I/O. The stream reconnects automatically if it
 * drops while the facet is open (see [rememberReconnectingObservationStream]); [backoffDelay] and
 * [socketAvailable] are the injected timer/daemon-availability seams that let that recovery be
 * tested with virtual time.
 */
@Composable
fun LayoutFacet(
  column: DeviceColumn,
  observationStreamFactory: () -> ObservationStream = { ObservationStreamClient() },
  backoffDelay: suspend (attempt: Int) -> Unit = { attempt -> delay(reconnectBackoffMs(attempt)) },
  socketAvailable: () -> Boolean = { ObservationStreamClient.socketExists() },
) {
  val stream =
    rememberReconnectingObservationStream(
      deviceId = column.deviceId,
      streamFactory = observationStreamFactory,
      backoffDelay = backoffDelay,
      socketAvailable = socketAvailable,
    )
  stream?.let { activeStream ->
    LayoutInspectorDashboard(
      dataSourceMode = DataSourceMode.Real,
      observationStream = activeStream,
      deviceId = column.deviceId,
      platform = if (column.platform == Platform.Ios) "ios" else "android",
    )
  }
}
