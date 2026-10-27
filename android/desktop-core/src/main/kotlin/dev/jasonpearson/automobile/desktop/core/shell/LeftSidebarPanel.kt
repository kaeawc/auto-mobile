package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.datasource.InstalledApp
import dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo
import dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse
import dev.jasonpearson.automobile.desktop.core.mcp.McpProcess
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/**
 * Left sidebar panel composing MCP connection, daemon status, device list, and app filter sections.
 */
data class LeftSidebarOptions(
  val dataSourceMode: DataSourceMode,
  val onDataSourceModeChanged: (DataSourceMode) -> Unit,
  val onDeviceSelected: (deviceId: String, deviceName: String?) -> Unit,
  val onProcessConnected: (McpProcess?) -> Unit,
  val connectedProcess: McpProcess?,
  val activeDeviceId: String?,
  val suppressAutoSelect: Boolean,
  val installedApps: List<InstalledApp> = emptyList(),
  val selectedAppId: String? = null,
  val onAppSelected: (String?) -> Unit = {},
  val onDeviceAction: ((deviceId: String, action: String) -> Unit)? = null,
  val favoriteDeviceIds: Set<String> = emptySet(),
  val onToggleFavorite: ((deviceId: String) -> Unit)? = null,
  val modifier: Modifier = Modifier,
  val bootedDevices: List<BootedDeviceInfo>? = null,
  val onRetryDetection: (() -> Unit)? = null,
  val onKillDevice: ((String) -> Unit)? = null,
  /** Why the last kill of a device failed, by device id; shown on its row. */
  val killDeviceErrors: Map<String, String> = emptyMap(),
  val onOpenSettings: (() -> Unit)? = null,
  val availableDevicesContent: (@Composable () -> Unit)? = null,
  val daemonStatusProvider: (suspend () -> DaemonStatusResponse?)? = null,
  val daemonSocketPath: String? = null,
)

@Composable
fun LeftSidebarPanel(options: LeftSidebarOptions) {
  with(options) {
    val colors = SharedTheme.globalColors
    val scrollState = rememberScrollState()

    Column(
      modifier =
        modifier
          .fillMaxHeight()
          .background(colors.panelBackground.copy(alpha = 0.85f))
          .verticalScroll(scrollState)
          .padding(12.dp),
      verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      SidebarConnectionSections(options)

      DeviceListSection(
        options =
          DeviceListOptions(
            dataSourceMode = dataSourceMode,
            connectedProcess = connectedProcess,
            onDeviceSelected = onDeviceSelected,
            activeDeviceId = activeDeviceId,
            suppressAutoSelect = suppressAutoSelect,
            onDeviceAction = onDeviceAction,
            favoriteDeviceIds = favoriteDeviceIds,
            onToggleFavorite = onToggleFavorite,
            devices = bootedDevices,
            onKillDevice = onKillDevice,
            killDeviceErrors = killDeviceErrors,
          ),
        modifier = Modifier.fillMaxWidth(),
      )

      availableDevicesContent?.invoke()

      AppFilterSection(
        installedApps = installedApps,
        selectedAppId = selectedAppId,
        onAppSelected = onAppSelected,
        modifier = Modifier.fillMaxWidth(),
      )
      onOpenSettings?.let { openSettings ->
        Text(
          "\u2699 Settings",
          color = colors.text.normal,
          modifier = Modifier.clickable(onClick = openSettings).padding(vertical = 4.dp),
        )
      }
    }
  }
}

@Composable
private fun SidebarConnectionSections(options: LeftSidebarOptions) {
  with(options) {
    McpConnectionSection(
      options =
        McpConnectionOptions(
          dataSourceMode = dataSourceMode,
          onDataSourceModeChanged = onDataSourceModeChanged,
          onProcessConnected = onProcessConnected,
          connectedProcess = connectedProcess,
          onRetryDetection = onRetryDetection,
        ),
      modifier = Modifier.fillMaxWidth(),
    )

    DaemonStatusSection(
      dev.jasonpearson.automobile.desktop.core.shell.DaemonStatusOptions(
        dataSourceMode = dataSourceMode,
        statusProvider = daemonStatusProvider,
        providedSocketPath = daemonSocketPath,
        refreshKey = connectedProcess,
        modifier = Modifier.fillMaxWidth(),
      ),
    )
  }
}
