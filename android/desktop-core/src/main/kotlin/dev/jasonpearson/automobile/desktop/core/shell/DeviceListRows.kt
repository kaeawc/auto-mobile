package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.mcp.BootedDeviceInfo
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun DevicePlatformGroup(
  label: String,
  icon: String,
  devices: List<BootedDeviceInfo>,
  options: DeviceListOptions,
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
        isSelected = deviceId == options.activeDeviceId,
        isFavorite = deviceId in options.favoriteDeviceIds,
        actions = deviceRowActions(device, options),
      )
      options.killDeviceErrors[deviceId]?.let { message ->
        Text(
          message,
          fontSize = 10.sp,
          color = Color(0xFFE53935),
          maxLines = 3,
          overflow = TextOverflow.Ellipsis,
          modifier = Modifier.padding(horizontal = 8.dp),
        )
      }
    }
  }
}

@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable
private fun DeviceRow(
  device: BootedDeviceInfo,
  isSelected: Boolean,
  isFavorite: Boolean,
  actions: DeviceRowActions,
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
          .semantics { selected = isSelected }
          .clickable { actions.onSelect() }
          .onPointerEvent(PointerEventType.Press) { event ->
            if (actions.onDeviceAction != null && event.button == PointerButton.Secondary) {
              showContextMenu = true
            }
          }
          .pointerHoverIcon(PointerIcon.Hand)
          .padding(horizontal = 8.dp, vertical = 4.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      DeviceRowContent(device, isSelected, isFavorite, actions)
    }

    DeviceRowMenu(showContextMenu, { showContextMenu = false }, actions.onDeviceAction)
  }
}

private data class DeviceRowActions(
  val onSelect: () -> Unit,
  val onToggleFavorite: (() -> Unit)?,
  val onKillDevice: (() -> Unit)?,
  val onDeviceAction: ((String) -> Unit)?,
)

@Composable
private fun RowScope.DeviceRowContent(
  device: BootedDeviceInfo,
  isSelected: Boolean,
  isFavorite: Boolean,
  actions: DeviceRowActions,
) {
  val colors = SharedTheme.globalColors
  if (actions.onToggleFavorite != null) {
    Text(
      if (isFavorite) "\u2605" else "\u2606",
      fontSize = 12.sp,
      color = if (isFavorite) Color(0xFFFFC107) else colors.text.normal.copy(alpha = 0.3f),
      modifier =
        Modifier.clickable { actions.onToggleFavorite() }
          .pointerHoverIcon(PointerIcon.Hand)
          .padding(end = 4.dp),
    )
  }

  DeviceRowIdentity(device, isSelected, Modifier.weight(1f))

  Row(
    horizontalArrangement = Arrangement.spacedBy(4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    actions.onKillDevice?.let { kill ->
      Text(
        "\u23F9",
        color = colors.text.error,
        modifier =
          Modifier.semantics { contentDescription = "Kill ${device.name}" }
            .clickable(onClick = kill)
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(4.dp),
      )
    }
    if (isSelected) {
      Text(
        "\u2713",
        fontSize = 12.sp,
        color = colors.outlines.focused,
      )
    }
  }
}

@Composable
private fun DeviceRowMenu(
  expanded: Boolean,
  onDismiss: () -> Unit,
  onDeviceAction: ((String) -> Unit)?,
) {
  DropdownMenu(
    expanded = expanded,
    onDismissRequest = onDismiss,
  ) {
    DropdownMenuItem(
      text = { Text("Take Screenshot", fontSize = 12.sp) },
      onClick = {
        onDismiss()
        onDeviceAction?.invoke("screenshot")
      },
    )
    DropdownMenuItem(
      text = { Text("Reboot Device", fontSize = 12.sp) },
      onClick = {
        onDismiss()
        onDeviceAction?.invoke("reboot")
      },
    )
    DropdownMenuItem(
      text = { Text("Clear App Data", fontSize = 12.sp) },
      onClick = {
        onDismiss()
        onDeviceAction?.invoke("clearAppData")
      },
    )
  }
}

@Composable
private fun DeviceRowIdentity(device: BootedDeviceInfo, isSelected: Boolean, modifier: Modifier) {
  val colors = SharedTheme.globalColors
  Column(modifier = modifier) {
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
}

private fun deviceRowActions(
  device: BootedDeviceInfo,
  options: DeviceListOptions,
): DeviceRowActions {
  val deviceId = device.runtime.deviceId ?: device.identity.stableId
  return DeviceRowActions(
    onSelect = { options.onDeviceSelected(deviceId, device.name) },
    // Preserve legacy affordances for self-fetching callers; host-owned lists only show
    // actions that the host can perform.
    onToggleFavorite =
      if (options.onToggleFavorite != null || (options.devices == null)) {
        {
          options.onToggleFavorite?.invoke(deviceId)
        }
      } else null,
    onKillDevice = options.onKillDevice?.let { callback -> { callback(deviceId) } },
    onDeviceAction =
      if (options.onDeviceAction != null || (options.devices == null)) {
        { action: String ->
          options.onDeviceAction?.invoke(deviceId, action)
        }
      } else null,
  )
}
