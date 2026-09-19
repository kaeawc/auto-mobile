package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerButton
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.onPointerEvent
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.datasource.DataSourceMode
import dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo
import dev.jasonpearson.automobile.desktop.core.mcp.DeviceResourceParser
import dev.jasonpearson.automobile.desktop.core.mcp.McpProcess
import dev.jasonpearson.automobile.desktop.core.mcp.ResourceReadResult
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Section displaying a list of booted devices grouped by platform, with context menus, health
 * indicators, and favorite device support.
 */
@Composable
fun DeviceListSection(
  dataSourceMode: DataSourceMode,
  connectedProcess: McpProcess?,
  onDeviceSelected: (deviceId: String, deviceName: String?) -> Unit,
  activeDeviceId: String?,
  suppressAutoSelect: Boolean,
  onDeviceAction: ((deviceId: String, action: String) -> Unit)? = null,
  favoriteDeviceIds: Set<String> = emptySet(),
  onToggleFavorite: ((deviceId: String) -> Unit)? = null,
  modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  var expanded by remember { mutableStateOf(true) }
  var bootedDevices by remember { mutableStateOf<List<BootedDeviceInfo>>(emptyList()) }
  var isLoading by remember { mutableStateOf(true) }
  var error by remember { mutableStateOf<String?>(null) }

  // Fetch devices -- re-run when the data-source mode or connected process changes
  LaunchedEffect(dataSourceMode, connectedProcess) {
    isLoading = true
    error = null
    val client =
      if (dataSourceMode == DataSourceMode.Real) {
        try {
          val daemonClient =
            withContext(Dispatchers.IO) {
              dev.jasonpearson.automobile.desktop.core.daemon.McpClientFactory.createFromProcess(
                connectedProcess
              )
            }
          dev.jasonpearson.automobile.desktop.core.mcp.DaemonMcpResourceClient(daemonClient)
        } catch (e: Exception) {
          error = e.message ?: "Failed to connect to daemon"
          isLoading = false
          return@LaunchedEffect
        }
      } else {
        dev.jasonpearson.automobile.desktop.core.mcp.McpResourceClientFactory.createFake()
      }
    try {
      val result =
        withContext(Dispatchers.IO) {
          client.readResource("automobile:devices/booted")
        }
      when (result) {
        is ResourceReadResult.Success -> {
          val parsed = DeviceResourceParser.parseBootedDevices(result.content)
          bootedDevices = parsed?.devices ?: emptyList()
        }
        is ResourceReadResult.Error -> {
          error = result.message
        }
      }
      withContext(Dispatchers.IO) { client.close() }
    } catch (e: Exception) {
      error = e.message ?: "Failed to fetch devices"
    }
    isLoading = false
  }

  // Auto-select single device
  LaunchedEffect(bootedDevices, suppressAutoSelect) {
    if (!suppressAutoSelect && bootedDevices.size == 1 && activeDeviceId == null) {
      val device = bootedDevices.first()
      onDeviceSelected(device.runtime.deviceId ?: device.identity.stableId, device.name)
    }
  }

  // Sort: favorites first, then alphabetically by name
  val sortedDevices =
    remember(bootedDevices, favoriteDeviceIds) {
      bootedDevices.sortedWith(
        compareByDescending<BootedDeviceInfo> {
            (it.runtime.deviceId ?: it.identity.stableId) in favoriteDeviceIds
          }
          .thenBy { it.name }
      )
    }

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
      trailing = {
        if (isLoading) {
          Text(
            "Loading...",
            fontSize = 10.sp,
            color = Color(0xFF2196F3),
            maxLines = 1,
            softWrap = false,
          )
        } else if (bootedDevices.isNotEmpty()) {
          Text(
            "${bootedDevices.size}",
            fontSize = 10.sp,
            color = colors.text.normal.copy(alpha = 0.5f),
            maxLines = 1,
            softWrap = false,
          )
        }
      },
    )

    if (expanded) {
      if (error != null) {
        Text(
          error!!,
          fontSize = 10.sp,
          color = Color(0xFFE53935),
        )
      } else if (!isLoading && sortedDevices.isEmpty()) {
        Text(
          "No devices found",
          fontSize = 11.sp,
          color = colors.text.normal.copy(alpha = 0.5f),
          maxLines = 1,
          softWrap = false,
        )
      } else if (!isLoading) {
        // Group by platform
        val androidDevices = sortedDevices.filter { it.platform == "android" }
        val iosDevices = sortedDevices.filter { it.platform == "ios" }

        if (androidDevices.isNotEmpty()) {
          DevicePlatformGroup(
            label = "Android",
            icon = "\uD83E\uDD16",
            devices = androidDevices,
            activeDeviceId = activeDeviceId,
            onDeviceSelected = onDeviceSelected,
            onDeviceAction = onDeviceAction,
            favoriteDeviceIds = favoriteDeviceIds,
            onToggleFavorite = onToggleFavorite,
          )
        }
        if (iosDevices.isNotEmpty()) {
          DevicePlatformGroup(
            label = "iOS",
            icon = "\uD83C\uDF4E",
            devices = iosDevices,
            activeDeviceId = activeDeviceId,
            onDeviceSelected = onDeviceSelected,
            onDeviceAction = onDeviceAction,
            favoriteDeviceIds = favoriteDeviceIds,
            onToggleFavorite = onToggleFavorite,
          )
        }
      }
    }
  }
}

@Composable
private fun DevicePlatformGroup(
  label: String,
  icon: String,
  devices: List<BootedDeviceInfo>,
  activeDeviceId: String?,
  onDeviceSelected: (deviceId: String, deviceName: String?) -> Unit,
  onDeviceAction: ((deviceId: String, action: String) -> Unit)?,
  favoriteDeviceIds: Set<String>,
  onToggleFavorite: ((deviceId: String) -> Unit)?,
) {
  val colors = SharedTheme.globalColors

  Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Text(
      "$icon $label (${devices.size})",
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
      maxLines = 1,
      softWrap = false,
    )
    devices.forEach { device ->
      val deviceId = device.runtime.deviceId ?: device.identity.stableId
      DeviceRow(
        device = device,
        isSelected = deviceId == activeDeviceId,
        isFavorite = deviceId in favoriteDeviceIds,
        onSelect = { onDeviceSelected(deviceId, device.name) },
        onToggleFavorite = { onToggleFavorite?.invoke(deviceId) },
        onDeviceAction =
          onDeviceAction?.let { callback ->
            { action: String -> callback(deviceId, action) }
          },
      )
    }
  }
}

@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable
private fun DeviceRow(
  device: BootedDeviceInfo,
  isSelected: Boolean,
  isFavorite: Boolean,
  onSelect: () -> Unit,
  onToggleFavorite: () -> Unit,
  onDeviceAction: ((String) -> Unit)?,
) {
  val colors = SharedTheme.globalColors
  var showContextMenu by remember { mutableStateOf(false) }

  Box {
    Row(
      modifier =
        Modifier.fillMaxWidth()
          .background(
            if (isSelected) colors.outlines.focused.copy(alpha = 0.12f) else Color.Transparent,
            RoundedCornerShape(4.dp),
          )
          .clickable { onSelect() }
          .onPointerEvent(PointerEventType.Press) { event ->
            if (event.button == PointerButton.Secondary) {
              showContextMenu = true
            }
          }
          .pointerHoverIcon(PointerIcon.Hand)
          .padding(horizontal = 8.dp, vertical = 4.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        if (isFavorite) "\u2605" else "\u2606",
        fontSize = 12.sp,
        color = if (isFavorite) Color(0xFFFFC107) else colors.text.normal.copy(alpha = 0.3f),
        modifier =
          Modifier.clickable { onToggleFavorite() }
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(end = 4.dp),
      )

      Column(modifier = Modifier.weight(1f)) {
        Text(
          device.name,
          fontSize = 12.sp,
          fontWeight = if (isSelected) FontWeight.Medium else FontWeight.Normal,
          color = colors.text.normal,
          maxLines = 1,
          softWrap = false,
          overflow = TextOverflow.Ellipsis,
        )
        Text(
          "${device.runtime.lifecycle.state} \u00B7 ${device.runtime.deviceId ?: device.identity.stableId}",
          fontSize = 10.sp,
          color = colors.text.normal.copy(alpha = 0.5f),
          maxLines = 1,
          softWrap = false,
          overflow = TextOverflow.Ellipsis,
        )
      }

      Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        if (isSelected) {
          Text(
            "\u2713",
            fontSize = 12.sp,
            color = colors.outlines.focused,
          )
        }
      }
    }

    DropdownMenu(
      expanded = showContextMenu,
      onDismissRequest = { showContextMenu = false },
    ) {
      DropdownMenuItem(
        text = { Text("Take Screenshot", fontSize = 12.sp) },
        onClick = {
          showContextMenu = false
          onDeviceAction?.invoke("screenshot")
        },
      )
      DropdownMenuItem(
        text = { Text("Reboot Device", fontSize = 12.sp) },
        onClick = {
          showContextMenu = false
          onDeviceAction?.invoke("reboot")
        },
      )
      DropdownMenuItem(
        text = { Text("Clear App Data", fontSize = 12.sp) },
        onClick = {
          showContextMenu = false
          onDeviceAction?.invoke("clearAppData")
        },
      )
    }
  }
}
