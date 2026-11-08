package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.daemon.DaemonStreamHub
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamKey
import dev.jasonpearson.automobile.desktop.core.daemon.TelemetryPushClient
import dev.jasonpearson.automobile.desktop.core.daemon.TelemetryPushSocketClient
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.telemetry.LogPlatform
import dev.jasonpearson.automobile.desktop.core.telemetry.LogsPanel
import dev.jasonpearson.automobile.desktop.core.telemetry.LogsPanelOptions

/**
 * The log-level numeric scale this device's logs use (Android and iOS number levels differently).
 */
private fun Platform.toLogPlatform(): LogPlatform =
  if (this == Platform.Ios) LogPlatform.Ios else LogPlatform.Android

internal fun createLogsTelemetryClient(sessionUuidProvider: (() -> String?)? = null) =
  TelemetryPushSocketClient(sessionUuidProvider = sessionUuidProvider)

/**
 * Docked-facet body for [Tool.Logs]: a logs-only event stream with an always-on filter bar
 * (per-level chips + free-text search), scoped to a single pane's device. A [TelemetryPushClient]
 * is created via [telemetryClientFactory] and connected to [column]'s device while the facet is
 * shown, then disposed when it leaves composition or the device changes.
 *
 * With a [streamHub] the client is a lease on the hub's one shared telemetry connection, routed by
 * the pane's [DeviceColumn.deviceSessionUuid]; without one it is a dedicated per-pane
 * [TelemetryPushSocketClient]. [telemetryClientFactory] is injected so the connect/dispose
 * lifecycle can be verified with a fake instead of real socket I/O.
 */
@Composable
fun LogsFacet(
  column: DeviceColumn,
  // An omitted provider retains legacy behavior; a supplied provider gates registration/release.
  sessionUuidProvider: (() -> String?)? = null,
  streamHub: DaemonStreamHub? = LocalDaemonStreamHub.current,
  telemetryClientFactory: (String) -> TelemetryPushClient = { deviceId ->
    streamHub?.telemetryClient(DeviceStreamKey(deviceId, column.deviceSessionUuid))
      ?: createLogsTelemetryClient(sessionUuidProvider = sessionUuidProvider)
  },
) {
  val graph = LocalAutoMobileGraph.current
  val sessionReady = sessionUuidProvider == null || sessionUuidProvider.invoke() != null
  var client by remember(column.deviceId) { mutableStateOf<TelemetryPushClient?>(null) }
  DisposableEffect(column.deviceId, column.deviceSessionUuid, sessionUuidProvider, sessionReady) {
    val connected =
      if (sessionReady) {
        telemetryClientFactory(column.deviceId).also {
          it.connect(deviceId = column.deviceId, deviceSessionUuid = column.deviceSessionUuid)
        }
      } else null
    client = connected
    onDispose {
      connected?.dispose()
      client = null
    }
  }
  LogsPanel(
    telemetryPushClient = client,
    settingsProvider = graph.settingsProvider,
    options =
      LogsPanelOptions(
        activeDeviceId = column.deviceId,
        platform = column.platform.toLogPlatform(),
      ),
  )
}
