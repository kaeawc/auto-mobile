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
import dev.jasonpearson.automobile.desktop.core.layout.LayoutInspectorDashboard

/**
 * Docked-facet body for the Layout Inspector, scoped to a single pane's device. An
 * [ObservationStream] is created via [observationStreamFactory] and connected to [column]'s device
 * while the facet is shown, then disposed when it leaves composition or the device changes — the
 * same per-device connect/dispose lifecycle as [LogsFacet]. Each pane therefore drives its own
 * stream and mirror, rather than following the app's active device.
 *
 * [observationStreamFactory] is injected (defaulting to a real per-device
 * [ObservationStreamClient]) so the connect/dispose lifecycle can be verified with a
 * [FakeObservationStream] instead of real socket I/O.
 */
@Composable
fun LayoutFacet(
  column: DeviceColumn,
  observationStreamFactory: () -> ObservationStream = { ObservationStreamClient() },
) {
  var stream by remember(column.deviceId) { mutableStateOf<ObservationStream?>(null) }
  DisposableEffect(column.deviceId) {
    val connected = observationStreamFactory().also { it.connect(deviceId = column.deviceId) }
    stream = connected
    onDispose {
      connected.dispose()
      stream = null
    }
  }
  stream?.let { activeStream ->
    LayoutInspectorDashboard(
      dataSourceMode = DataSourceMode.Real,
      observationStream = activeStream,
      deviceId = column.deviceId,
      platform = if (column.platform == Platform.Ios) "ios" else "android",
    )
  }
}
