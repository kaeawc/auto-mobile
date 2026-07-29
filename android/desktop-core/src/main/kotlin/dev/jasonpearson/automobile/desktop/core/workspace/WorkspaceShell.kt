package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

private val StatusGreen = Color(0xFF40C057)
private val StatusYellow = Color(0xFFF0C000)
private val StatusRed = Color(0xFFFA5252)
private val Accent = Color(0xFF4DABF7)

/**
 * Root of the device-tab workspace. Device identity lives in each column header (no top tab bar); a
 * device is observed (a column) or not. This PR lands the shell, the empty state, and the column
 * chrome; real streams, emulator controls, facets, and the picker arrive in later PRs.
 */
@Composable
fun WorkspaceShell(
  state: WorkspaceUiState,
  onAction: (WorkspaceAction) -> Unit,
  onOpenPicker: () -> Unit,
  status: WorkspaceStatus = WorkspaceStatus.Green,
  modifier: Modifier = Modifier,
) {
  Column(modifier.fillMaxSize()) {
    TopBar(status = status, onOpenPicker = onOpenPicker)
    when (state) {
      is WorkspaceUiState.Empty -> EmptyState(onOpenPicker, Modifier.weight(1f).fillMaxWidth())
      is WorkspaceUiState.Content ->
        Row(Modifier.weight(1f).fillMaxWidth()) {
          state.columns.forEach { column ->
            DeviceColumnView(
              column = column,
              focused = column.deviceId == state.focusedDeviceId,
              onAction = onAction,
              modifier = Modifier.weight(1f).fillMaxHeight(),
            )
          }
        }
    }
  }
}

@Composable
private fun TopBar(status: WorkspaceStatus, onOpenPicker: () -> Unit) {
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .height(40.dp)
        .background(MaterialTheme.colorScheme.surfaceVariant)
        .padding(horizontal = 12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Row(
      modifier =
        Modifier.clickable { onOpenPicker() }
          .semantics { contentDescription = "Devices" }
          .padding(horizontal = 8.dp, vertical = 4.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text("Devices", style = MaterialTheme.typography.labelLarge)
      Text("  +", color = Accent, fontWeight = FontWeight.Bold)
    }
    Spacer(Modifier.weight(1f))
    Box(
      modifier =
        Modifier.size(12.dp).background(status.color(), CircleShape).semantics {
          contentDescription = "Status: ${status.name}"
        }
    )
  }
}

@Composable
private fun EmptyState(onOpenPicker: () -> Unit, modifier: Modifier) {
  Column(
    modifier = modifier,
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(
      "No devices observed",
      style = MaterialTheme.typography.headlineSmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Spacer(Modifier.height(12.dp))
    Box(
      modifier =
        Modifier.clickable { onOpenPicker() }
          .semantics { contentDescription = "Open Devices" }
          .background(Accent, RoundedCornerShape(6.dp))
          .padding(horizontal = 20.dp, vertical = 10.dp)
    ) {
      Text("Open Devices", color = Color.White)
    }
  }
}

@Composable
private fun DeviceColumnView(
  column: DeviceColumn,
  focused: Boolean,
  onAction: (WorkspaceAction) -> Unit,
  modifier: Modifier,
) {
  Column(
    modifier =
      modifier.border(
        width = if (focused) 2.dp else 1.dp,
        color = if (focused) Accent else MaterialTheme.colorScheme.outlineVariant,
      )
  ) {
    DeviceColumnHeader(column, onAction)
    // placeholder stream area — the real WebRTC stream lands in a later PR; the emulator controls
    // float over it now.
    Box(
      modifier =
        Modifier.weight(1f).fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant),
      contentAlignment = Alignment.Center,
    ) {
      Text("stream", color = MaterialTheme.colorScheme.outline)
      EmulatorControls(
        column = column,
        onAction = onAction,
        modifier = Modifier.align(Alignment.TopCenter).padding(6.dp),
      )
    }
  }
}

/**
 * Emulator controls floating on a device stream: rotate · screenshot · snapshot, plus a contextual
 * 🔓 Unlock shown only when the device is locked. Each is a one-shot [WorkspaceAction.RunControl].
 */
@Composable
private fun EmulatorControls(
  column: DeviceColumn,
  onAction: (WorkspaceAction) -> Unit,
  modifier: Modifier,
) {
  Row(modifier, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
    // Unlock is gated on the pane's lock state; rotate/screenshot/snapshot always show. Production
    // does not yet feed DeviceColumn.locked (that needs device-state plumbing), so Unlock only
    // becomes reachable once #4694 wires the observed lock state in.
    EmulatorControl.entries
      .filter { it != EmulatorControl.Unlock || column.locked }
      .forEach { control ->
        Glyph(
          text = control.icon,
          description = "${control.label} ${column.name}",
          active = false,
          onClick = { onAction(WorkspaceAction.RunControl(column.deviceId, control)) },
        )
      }
  }
}

@Composable
private fun DeviceColumnHeader(column: DeviceColumn, onAction: (WorkspaceAction) -> Unit) {
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .height(34.dp)
        .background(MaterialTheme.colorScheme.surface)
        .padding(horizontal = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(column.platform.emoji)
    Spacer(Modifier.width(6.dp))
    Text(column.name, style = MaterialTheme.typography.labelLarge)
    Spacer(Modifier.width(10.dp))
    ModeToggle(column, onAction)
    Spacer(Modifier.weight(1f))
    Tool.entries.forEach { tool ->
      Glyph(
        text = tool.icon,
        description = tool.label,
        active = column.activeTool == tool,
        onClick = { onAction(WorkspaceAction.SelectTool(column.deviceId, tool)) },
      )
    }
    Spacer(Modifier.width(4.dp))
    Glyph(
      text = "⤡",
      description = "Shrink ${column.name}",
      active = column.shrunk,
      onClick = { onAction(WorkspaceAction.ToggleShrink(column.deviceId)) },
    )
    Glyph(
      text = "✕",
      description = "Close ${column.name}",
      active = false,
      onClick = { onAction(WorkspaceAction.CloseDevice(column.deviceId)) },
    )
  }
}

@Composable
private fun ModeToggle(column: DeviceColumn, onAction: (WorkspaceAction) -> Unit) {
  Row {
    ToggleCell(
      text = "✋",
      description = "Input mode",
      active = column.mode == InteractionMode.Input,
      onClick = { onAction(WorkspaceAction.SetMode(column.deviceId, InteractionMode.Input)) },
    )
    ToggleCell(
      text = "🔍",
      description = "Inspect mode",
      active = column.mode == InteractionMode.Inspect,
      onClick = { onAction(WorkspaceAction.SetMode(column.deviceId, InteractionMode.Inspect)) },
    )
  }
}

@Composable
private fun ToggleCell(text: String, description: String, active: Boolean, onClick: () -> Unit) {
  Box(
    modifier =
      Modifier.clickable(onClick = onClick)
        .semantics { contentDescription = description }
        .background(
          if (active) Accent else Color.Transparent,
          RoundedCornerShape(4.dp),
        )
        .padding(horizontal = 6.dp, vertical = 3.dp)
  ) {
    Text(text)
  }
}

@Composable
private fun Glyph(text: String, description: String, active: Boolean, onClick: () -> Unit) {
  Box(
    modifier =
      Modifier.clickable(onClick = onClick)
        .semantics { contentDescription = description }
        .background(
          if (active) Accent.copy(alpha = 0.35f) else Color.Transparent,
          RoundedCornerShape(4.dp),
        )
        .padding(horizontal = 4.dp, vertical = 2.dp)
  ) {
    Text(text)
  }
}

private fun WorkspaceStatus.color(): Color =
  when (this) {
    WorkspaceStatus.Green -> StatusGreen
    WorkspaceStatus.Yellow -> StatusYellow
    WorkspaceStatus.Red -> StatusRed
  }
