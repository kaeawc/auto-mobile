package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.performance.PerformanceDashboard
import kotlinx.coroutines.delay

/**
 * Docked-facet body for [Tool.Performance]: the performance dashboard scoped to a single pane's
 * device. A per-pane [ObservationStream] is created via [observationStreamFactory] and connected to
 * [column]'s device while the facet is shown, then disposed when it leaves composition or the
 * device changes. The dashboard's live metrics (fps, frame time, jank, memory, …) are pushed from
 * that stream and filtered to [column]'s device, so panes in a multi-device workspace stay
 * isolated.
 *
 * [observationStreamFactory] is injected (defaulting to a real per-device
 * [ObservationStreamClient]) so the per-device connect/dispose lifecycle can be verified with a
 * [FakeObservationStream] instead of real socket I/O. The stream reconnects automatically if it
 * drops while the facet is open (see [rememberReconnectingObservationStream]); [backoffDelay] and
 * [socketAvailable] are the injected timer/daemon-availability seams that let that recovery be
 * tested with virtual time.
 *
 * Both the LIVE metrics (the stream carries a deviceId) and the audit-history fallback are scoped
 * to [column]'s device: [PerformanceDashboard] threads [DeviceColumn.deviceId] through
 * `listPerformanceAuditResults` so a pane only surfaces its own device's audit history.
 */
@Composable
fun PerformanceFacet(
  column: DeviceColumn,
  observationStreamFactory: (String) -> ObservationStream = { ObservationStreamClient() },
  backoffDelay: suspend (attempt: Int) -> Unit = { attempt -> delay(reconnectBackoffMs(attempt)) },
  socketAvailable: () -> Boolean = { ObservationStreamClient.socketExists() },
) {
  val graph = LocalAutoMobileGraph.current
  val stream =
    rememberReconnectingObservationStream(
      deviceId = column.deviceId,
      streamFactory = { observationStreamFactory(column.deviceId) },
      backoffDelay = backoffDelay,
      socketAvailable = socketAvailable,
    )
  PerformanceDashboard(
    dataSourceMode = DataSourceMode.Real,
    clientProvider = { graph.autoMobileClient },
    observationStreamClient = stream,
    deviceId = column.deviceId,
  )
}
