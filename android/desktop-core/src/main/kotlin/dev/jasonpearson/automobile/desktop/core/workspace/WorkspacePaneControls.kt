package dev.jasonpearson.automobile.desktop.core.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.components.Tooltip
import dev.jasonpearson.automobile.desktop.core.theme.PlatformIcons

/**
 * Emulator controls floating on a device stream: rotate · screenshot · snapshot, plus a contextual
 * 🔓 Unlock shown only when the device is locked (fed by the host's lock-state poll, #4694 AC0).
 * Rotate/Snapshot/Unlock are one-shot [WorkspaceAction.RunControl] device calls; Screenshot instead
 * triggers [onCaptureScreenshot], because it captures the current frame to disk (surfaced in the
 * pane as a confirmation) rather than being a fire-and-forget device mutation.
 */
@Composable
internal fun DeviceCommandBar(
  column: DeviceColumn,
  onAction: (WorkspaceAction) -> Unit,
  onCaptureScreenshot: () -> Unit,
  modifier: Modifier,
) {
  Column(
    modifier =
      modifier
        .clip(RoundedCornerShape(18.dp))
        .background(Color.Black.copy(alpha = 0.32f))
        .padding(4.dp),
    verticalArrangement = Arrangement.spacedBy(2.dp),
  ) {
    // Device navigation: Back / Home / Recent.
    listOf(DeviceButton.Back, DeviceButton.Home, DeviceButton.Recent)
      .filter { it.isSupportedOn(column.platform, column.isVirtual) }
      .forEach { button ->
        CrayonButton(button.crayon(), "${button.label} ${column.name}") {
          onAction(WorkspaceAction.PressDeviceButton(column.deviceId, button))
        }
      }
    // Emulator controls: Unlock is gated on lock state; Screenshot captures to disk; Locale opens a
    // picker; the rest are one-shot device calls. More is dropped — every device button is surfaced
    // in this bar directly.
    EmulatorControl.entries
      .filter { it != EmulatorControl.More }
      .filter { it != EmulatorControl.Unlock || column.locked }
      .filter { it.isSupportedOn(column.platform, column.isVirtual) }
      .forEach { control ->
        when (control) {
          EmulatorControl.Screenshot ->
            CrayonButton(
              control.crayon(),
              "${control.label} ${column.name}",
              onClick = onCaptureScreenshot,
            )
          EmulatorControl.Locale -> LocaleControl(column, onAction)
          else ->
            CrayonButton(control.crayon(), "${control.label} ${column.name}") {
              onAction(WorkspaceAction.RunControl(column.deviceId, control))
            }
        }
      }
    // Power, at the foot of the bar.
    if (DeviceButton.Power.isSupportedOn(column.platform, column.isVirtual)) {
      CrayonButton(DeviceButton.Power.crayon(), "${DeviceButton.Power.label} ${column.name}") {
        onAction(WorkspaceAction.PressDeviceButton(column.deviceId, DeviceButton.Power))
      }
    }
  }
}

/** An outline crayon icon button for the device command bar — white glyph, no fill. */
@Composable
internal fun CrayonButton(
  glyph: CrayonGlyph,
  description: String,
  active: Boolean = false,
  onClick: () -> Unit,
) {
  Tooltip(tooltip = { Text(description, style = MaterialTheme.typography.labelSmall) }) {
    Box(
      modifier =
        Modifier.size(30.dp)
          .clip(CircleShape)
          .then(if (active) Modifier.background(Color.White.copy(alpha = 0.16f)) else Modifier)
          .clickable(onClick = onClick)
          .semantics { contentDescription = description }
          .padding(6.dp),
      contentAlignment = Alignment.Center,
    ) {
      CrayonIcon(glyph, tint = Color.White, modifier = Modifier.fillMaxSize())
    }
  }
}

/**
 * Locale control: a crayon globe that opens a dropdown of [COMMON_LOCALES]; a pick sets the locale.
 */
@Composable
internal fun LocaleControl(column: DeviceColumn, onAction: (WorkspaceAction) -> Unit) {
  var open by remember { mutableStateOf(false) }
  Box {
    CrayonButton(
      EmulatorControl.Locale.crayon(),
      "${EmulatorControl.Locale.label} ${column.name}",
      open,
    ) {
      open = true
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
      COMMON_LOCALES.forEach { locale ->
        DropdownMenuItem(
          text = { Text("${locale.label} (${locale.tag})") },
          modifier =
            Modifier.semantics { contentDescription = "Locale ${locale.label} ${column.name}" },
          onClick = {
            open = false
            onAction(WorkspaceAction.SetLocale(column.deviceId, locale.tag))
          },
        )
      }
    }
  }
}

@Composable
internal fun DeviceColumnHeader(
  column: DeviceColumn,
  displayName: String,
  onAction: (WorkspaceAction) -> Unit,
) {
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .height(34.dp)
        .background(MaterialTheme.colorScheme.surface)
        .padding(horizontal = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    val isIos = column.platform == Platform.Ios
    Icon(
      imageVector = PlatformIcons.logo(isIos),
      contentDescription = PlatformIcons.contentDescription(isIos),
      tint = PlatformIcons.tint(isIos),
      modifier = Modifier.size(16.dp),
    )
    Spacer(Modifier.width(6.dp))
    Text(displayName, style = MaterialTheme.typography.labelLarge)
    Spacer(Modifier.width(10.dp))
    ModeToggle(column, onAction)
    Spacer(Modifier.weight(1f))
    Tool.entries.forEach { tool ->
      val active = column.activeTool == tool
      Glyph(
        text = tool.icon,
        // Device name disambiguates identical tool labels across panes for a11y / automation.
        description = "${tool.label} $displayName",
        active = active,
        // Re-tapping the active tool closes its facet.
        onClick = {
          onAction(WorkspaceAction.SelectTool(column.deviceId, if (active) null else tool))
        },
      )
    }
    Spacer(Modifier.width(4.dp))
    Glyph(
      text = "⤡",
      description = "Shrink $displayName",
      active = column.shrunk,
      onClick = { onAction(WorkspaceAction.ToggleShrink(column.deviceId)) },
    )
    Glyph(
      text = "✕",
      description = "Close $displayName",
      active = false,
      onClick = { onAction(WorkspaceAction.CloseDevice(column.deviceId)) },
    )
  }
}

@Composable
internal fun ModeToggle(column: DeviceColumn, onAction: (WorkspaceAction) -> Unit) {
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
internal fun ToggleCell(text: String, description: String, active: Boolean, onClick: () -> Unit) {
  Tooltip(tooltip = { Text(description, style = MaterialTheme.typography.labelSmall) }) {
    Box(
      modifier =
        Modifier.clickable(onClick = onClick)
          .semantics { contentDescription = description }
          .background(
            if (active) Accent else Color.Transparent,
            RoundedCornerShape(4.dp),
          )
          .padding(horizontal = 6.dp, vertical = 3.dp),
    ) {
      Text(text)
    }
  }
}

@Composable
internal fun Glyph(text: String, description: String, active: Boolean, onClick: () -> Unit) {
  Tooltip(tooltip = { Text(description, style = MaterialTheme.typography.labelSmall) }) {
    Box(
      modifier =
        Modifier.clickable(onClick = onClick)
          .semantics { contentDescription = description }
          .background(
            if (active) Accent.copy(alpha = 0.35f) else Color.Transparent,
            RoundedCornerShape(4.dp),
          )
          .padding(horizontal = 4.dp, vertical = 2.dp),
    ) {
      Text(text)
    }
  }
}
