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
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationDashboard
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationScreenshotLoader

/**
 * Docked-facet body for [Tool.Navigation]: the navigation dashboard scoped to a single pane's
 * device. An [ObservationStream] is created via [observationStreamFactory] and connected to
 * [column]'s device while the facet is shown, then disposed when it leaves composition or the
 * device changes — mirroring [LogsFacet]'s per-device connect/dispose lifecycle.
 *
 * [observationStreamFactory] is injected (defaulting to a real per-device
 * [ObservationStreamClient]) so the connect/dispose/request lifecycle can be verified with
 * [dev.jasonpearson.automobile.desktop .core.daemon.FakeObservationStream] instead of real socket
 * I/O.
 *
 * [selectedAppId] is left null so the stream's foreground-app-change logic drives which app's graph
 * is shown; no package needs to be pre-resolved. Navigation is platform-agnostic, so — unlike
 * [StorageFacet] — no Android-only guard is required.
 */
@Composable
fun NavigationFacet(
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
  // Stable across recompositions so NavigationDashboard's data-source effect (keyed on the provider
  // identity) doesn't relaunch and clobber stream-driven graph updates.
  val clientProvider = remember { { graph.autoMobileClient } }
  // Remembered per device so its LRU cache survives facet toggles.
  val screenshotLoader =
    remember(column.deviceId) { NavigationScreenshotLoader(clientProvider = clientProvider) }
  NavigationDashboard(
    observationStreamClient = stream,
    dataSourceMode = DataSourceMode.Real,
    clientProvider = clientProvider,
    settingsProvider = graph.settingsProvider,
    selectedAppId = null,
    screenshotLoader = screenshotLoader,
    // Drive the graph solely from this pane's per-device stream so a second pane on another device
    // never shows the active device's graph.
    streamOnly = true,
  )
}
