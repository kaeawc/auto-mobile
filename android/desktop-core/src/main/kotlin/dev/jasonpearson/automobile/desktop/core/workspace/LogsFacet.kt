package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.daemon.TelemetryPushClient
import dev.jasonpearson.automobile.desktop.core.daemon.TelemetryPushSocketClient
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDashboard

/**
 * Docked-facet body for [Tool.Logs]: the telemetry dashboard scoped to a single pane's device. A
 * [TelemetryPushClient] is created via [telemetryClientFactory] and connected to [column]'s device
 * while the facet is shown, then disposed when it leaves composition or the device changes.
 *
 * [telemetryClientFactory] is injected (defaulting to a real per-device
 * [TelemetryPushSocketClient]) so the per-device connect/dispose lifecycle can be verified with a
 * fake instead of real socket I/O.
 */
@Composable
fun LogsFacet(
  column: DeviceColumn,
  telemetryClientFactory: (String) -> TelemetryPushClient = { TelemetryPushSocketClient() },
) {
  var client by remember(column.deviceId) { mutableStateOf<TelemetryPushClient?>(null) }
  DisposableEffect(column.deviceId) {
    val connected =
      telemetryClientFactory(column.deviceId).also { it.connect(deviceId = column.deviceId) }
    client = connected
    onDispose {
      connected.dispose()
      client = null
    }
  }
  TelemetryDashboard(
    telemetryPushClient = client,
    dataSourceMode = DataSourceMode.Real,
    activeDeviceId = column.deviceId,
  )
}
