package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.datasource.InstalledApp
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.di.LocalAutoMobileGraph
import dev.jasonpearson.automobile.desktop.core.storage.StorageDashboard
import dev.jasonpearson.automobile.desktop.core.storage.StoragePlatform

/**
 * The package whose storage a pane inspects: the device's foreground app, else its first installed
 * app, else none. Pure so the choice is unit-testable.
 */
internal fun resolveStoragePackage(apps: List<InstalledApp>): String? =
  apps.firstOrNull { it.isForeground }?.packageName ?: apps.firstOrNull()?.packageName

/** Map the workspace [Platform] to the storage layer's [StoragePlatform]. */
internal fun Platform.toStoragePlatform(): StoragePlatform =
  if (this == Platform.Ios) StoragePlatform.iOS else StoragePlatform.Android

/**
 * Docked-facet body for [Tool.Storage]: the storage dashboard scoped to a pane's device and its
 * resolved app. The app is auto-resolved (foreground, else first installed) via
 * [loadInstalledApps], which is injected so the resolution and its loading/empty states are
 * testable without real MCP; the default reads the device's installed-app list through the DI
 * graph.
 */
@Composable
fun StorageFacet(
  column: DeviceColumn,
  loadInstalledApps: (suspend (String) -> List<InstalledApp>)? = null,
) {
  val graph = LocalAutoMobileGraph.current
  val loader: suspend (String) -> List<InstalledApp> =
    loadInstalledApps
      ?: { deviceId ->
        val source =
          graph.dataSourceFactory.createAppListDataSource(
            DataSourceMode.Real,
            { graph.autoMobileClient },
            deviceId,
          )
        (source.getInstalledApps() as? Result.Success)?.data ?: emptyList()
      }
  var resolvedPackage by remember(column.deviceId) { mutableStateOf<String?>(null) }
  var resolving by remember(column.deviceId) { mutableStateOf(true) }
  LaunchedEffect(column.deviceId) {
    resolving = true
    resolvedPackage = resolveStoragePackage(loader(column.deviceId))
    resolving = false
  }
  val packageName = resolvedPackage
  when {
    resolving -> FacetNote("Resolving app…")
    packageName == null -> FacetNote("No app found on this device")
    else ->
      StorageDashboard(
        dataSourceMode = DataSourceMode.Real,
        clientProvider = { graph.autoMobileClient },
        deviceId = column.deviceId,
        packageName = packageName,
        platform = column.platform.toStoragePlatform(),
      )
  }
}

/** Centered single-line note for a facet's transient (resolving) or empty states. */
@Composable
private fun FacetNote(text: String) {
  Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    Text(text, color = MaterialTheme.colorScheme.outline)
  }
}
