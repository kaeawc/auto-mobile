package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.runtime.Composable
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.failures.FailuresDashboard

/**
 * Docked-facet body for [Tool.Failures]: the failures dashboard (crashes, ANRs, tool-call failures,
 * non-fatals).
 *
 * Unlike the per-device facets ([LogsFacet], [StorageFacet]), failures data is a **cross-device
 * global aggregate**: the daemon's `automobile:failures` resource is not device-filtered, so every
 * pane renders the same failures list regardless of which device [column] describes. This matches
 * the wireframe, which treats 💥 Failures as "cross-device by design"; a per-device filter is a
 * separate daemon follow-up. The [column] is accepted to keep a uniform facet signature with the
 * host's tool→facet mapping.
 *
 * [dataSourceMode] is injected (defaulting to [DataSourceMode.Real]) so the dashboard can be
 * rendered against fake data in tests without real MCP I/O. The client is read from the DI graph
 * and only touched by the dashboard in [DataSourceMode.Real].
 */
@Composable
fun FailuresFacet(
  column: DeviceColumn,
  dataSourceMode: DataSourceMode = DataSourceMode.Real,
) {
  val graph = LocalAutoMobileGraph.current
  FailuresDashboard(
    dataSourceMode = dataSourceMode,
    clientProvider = { graph.autoMobileClient },
  )
}
