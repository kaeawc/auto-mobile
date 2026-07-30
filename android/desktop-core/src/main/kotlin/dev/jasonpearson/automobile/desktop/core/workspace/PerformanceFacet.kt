package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStream
import dev.jasonpearson.automobile.desktop.core.daemon.ObservationStreamClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.performance.PerformanceDashboard

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
 * [FakeObservationStream] instead of real socket I/O.
 *
 * Note: only the LIVE metrics here are per-device (the stream carries a deviceId). The dashboard's
 * audit-history fallback still reads via the DI graph's active-device client — device-scoping that
 * path is a separate follow-up (thread deviceId through listPerformanceAuditResults), not fixed
 * here.
 */
@Composable
fun PerformanceFacet(
  column: DeviceColumn,
  observationStreamFactory: (String) -> ObservationStream = { ObservationStreamClient() },
) {
  val graph = LocalAutoMobileGraph.current
  var stream by remember(column.deviceId) { mutableStateOf<ObservationStream?>(null) }
  DisposableEffect(column.deviceId) {
    val connected =
      observationStreamFactory(column.deviceId).also { it.connect(deviceId = column.deviceId) }
    stream = connected
    onDispose {
      connected.dispose()
      stream = null
    }
  }
  PerformanceDashboard(
    dataSourceMode = DataSourceMode.Real,
    clientProvider = { graph.autoMobileClient },
    observationStreamClient = stream,
    deviceId = column.deviceId,
  )
}
