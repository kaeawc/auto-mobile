package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.daemon.McpClientFactory
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo
import dev.jasonpearson.automobile.desktop.core.mcp.DaemonMcpResourceClient
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceResourceParser
import dev.jasonpearson.automobile.desktop.core.mcp.McpProcess
import dev.jasonpearson.automobile.desktop.core.mcp.McpResourceClient
import dev.jasonpearson.automobile.desktop.core.mcp.McpResourceClientFactory
import dev.jasonpearson.automobile.desktop.core.mcp.ResourceReadResult
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import java.io.IOException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Inputs and host callbacks for the device list. */
data class DeviceListOptions(
  val dataSourceMode: DataSourceMode,
  val connectedProcess: McpProcess?,
  val onDeviceSelected: (deviceId: String, deviceName: String?) -> Unit,
  val activeDeviceId: String?,
  val suppressAutoSelect: Boolean,
  val onDeviceAction: ((deviceId: String, action: String) -> Unit)? = null,
  val favoriteDeviceIds: Set<String> = emptySet(),
  val onToggleFavorite: ((deviceId: String) -> Unit)? = null,
  val devices: List<BootedDeviceInfo>? = null,
  val onKillDevice: ((String) -> Unit)? = null,
  /** Why the last kill of a device failed, by device id; shown under its row. */
  val killDeviceErrors: Map<String, String> = emptyMap(),
)

private class DeviceListState {
  var devices by mutableStateOf<List<BootedDeviceInfo>>(emptyList())
  var isLoading by mutableStateOf(true)
  var error by mutableStateOf<String?>(null)

  fun failed(message: String, cause: Exception) {
    LoggerFactory.getLogger("DeviceListSection").warn(message, cause)
    error = cause.message ?: message
    isLoading = false
  }
}

/** Devices grouped by platform, with host-provided selection and action callbacks. */
@Composable
fun DeviceListSection(
  options: DeviceListOptions,
  modifier: Modifier = Modifier,
  ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
  val colors = SharedTheme.globalColors
  var expanded by remember { mutableStateOf(true) }
  val state = remember { DeviceListState() }
  LaunchedEffect(options.dataSourceMode, options.connectedProcess, options.devices) {
    loadDeviceList(options, state, ioDispatcher)
  }
  DeviceAutoSelection(state.devices, options)
  Column(
    modifier =
      modifier
        .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
        .padding(12.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    CollapsibleSectionHeader(
      title = "Devices",
      expanded = expanded,
      onToggle = { expanded = !expanded },
      trailing = { DeviceListCount(state) },
    )
    if (expanded) DeviceListContent(state, options)
  }
}

private suspend fun loadDeviceList(
  options: DeviceListOptions,
  state: DeviceListState,
  ioDispatcher: CoroutineDispatcher,
) {
  options.devices?.let {
    state.devices = it
    state.isLoading = false
    state.error = null
    return
  }
  state.isLoading = true
  state.error = null
  val client = createDeviceListClient(options, state, ioDispatcher) ?: return
  try {
    when (
      val result = withContext(ioDispatcher) { client.readResource("automobile:devices/booted") }
    ) {
      is ResourceReadResult.Success -> {
        state.devices =
          DeviceResourceParser.parseBootedDevices(result.content)?.devices ?: emptyList()
      }
      is ResourceReadResult.Error -> {
        LoggerFactory.getLogger("DeviceListSection")
          .warn("Failed to fetch devices: ${result.message}")
        state.error = result.message
      }
    }
    withContext(ioDispatcher) { client.close() }
  } catch (e: IOException) {
    state.failed("Failed to fetch devices", e)
  } catch (e: McpConnectionException) {
    state.failed("Failed to fetch devices", e)
  }
  state.isLoading = false
}

private suspend fun createDeviceListClient(
  options: DeviceListOptions,
  state: DeviceListState,
  ioDispatcher: CoroutineDispatcher,
): McpResourceClient? {
  return try {
    if (options.dataSourceMode == DataSourceMode.Real) {
      val daemonClient =
        withContext(ioDispatcher) {
          McpClientFactory.createFromProcess(options.connectedProcess)
        }
      DaemonMcpResourceClient(daemonClient)
    } else McpResourceClientFactory.createFake()
  } catch (e: UnsupportedOperationException) {
    state.failed("Failed to connect to daemon", e)
    null
  } catch (e: IllegalArgumentException) {
    state.failed("Failed to connect to daemon", e)
    null
  } catch (e: IOException) {
    state.failed("Failed to connect to daemon", e)
    null
  } catch (e: McpConnectionException) {
    state.failed("Failed to connect to daemon", e)
    null
  }
}

@Composable
private fun DeviceAutoSelection(bootedDevices: List<BootedDeviceInfo>, options: DeviceListOptions) {
  // Auto-select single device
  LaunchedEffect(bootedDevices, options.suppressAutoSelect) {
    if (!options.suppressAutoSelect && bootedDevices.size == 1 && options.activeDeviceId == null) {
      val device = bootedDevices.first()
      options.onDeviceSelected(device.runtime.deviceId ?: device.identity.stableId, device.name)
    }
  }
}

@Composable
private fun DeviceListCount(state: DeviceListState) {
  val colors = SharedTheme.globalColors
  if (state.isLoading) {
    Text("Loading...", fontSize = 10.sp, color = Color(0xFF2196F3), maxLines = 1, softWrap = false)
  } else if (state.devices.isNotEmpty()) {
    Text(
      "${state.devices.size}",
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
      maxLines = 1,
      softWrap = false,
    )
  }
}

@Composable
private fun DeviceListContent(state: DeviceListState, options: DeviceListOptions) {
  val colors = SharedTheme.globalColors
  val sortedDevices =
    remember(state.devices, options.favoriteDeviceIds) {
      state.devices.sortedWith(
        compareByDescending<BootedDeviceInfo> {
            (it.runtime.deviceId ?: it.identity.stableId) in options.favoriteDeviceIds
          }
          .thenBy { it.name },
      )
    }
  when {
    state.error != null ->
      Text(
        requireNotNull(state.error) { "Device loading error must be present" },
        fontSize = 10.sp,
        color = Color(0xFFE53935),
      )
    !state.isLoading && sortedDevices.isEmpty() ->
      Text(
        "No devices found",
        fontSize = 11.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
        maxLines = 1,
        softWrap = false,
      )
    !state.isLoading -> {
      val androidDevices = sortedDevices.filter { it.platform == "android" }
      val iosDevices = sortedDevices.filter { it.platform == "ios" }
      if (androidDevices.isNotEmpty()) {
        DevicePlatformGroup("Android", "\uD83E\uDD16", androidDevices, options)
      }
      if (iosDevices.isNotEmpty()) {
        DevicePlatformGroup("iOS", "\uD83C\uDF4E", iosDevices, options)
      }
    }
  }
}
