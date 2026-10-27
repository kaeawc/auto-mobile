@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.workspace.picker

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.isCtrlPressed
import androidx.compose.ui.input.pointer.isMetaPressed
import androidx.compose.ui.input.pointer.isShiftPressed
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.desktop.core.components.Tooltip
import dev.jasonpearson.automobile.desktop.core.theme.PlatformIcons
import dev.jasonpearson.automobile.desktop.core.workspace.Platform

private val Accent = Color(0xFF4DABF7)

internal data class DeviceCardOptions(
  val device: PickerDevice,
  val displayName: String,
  val selected: Boolean,
  val booting: Boolean,
  val error: String?,
  val finishingPreviousSession: Boolean,
  val thumbnail: @Composable (PickerDevice, Boolean) -> Unit,
  val onClick: (multiSelect: Boolean) -> Unit,
)

@Composable
internal fun DeviceCard(options: DeviceCardOptions) {
  val device = options.device
  val displayName = options.displayName
  val selected = options.selected
  val booting = options.booting
  val error = options.error
  val finishingPreviousSession = options.finishingPreviousSession
  val thumbnail = options.thumbnail
  val onClick = options.onClick

  val booted = device.state == DeviceState.Booted
  // A shut-down card boots on click (unless a boot is already in flight); a booted card observes.
  val clickable = booted || (device.state == DeviceState.Shutdown && !booting)
  val windowInfo = LocalWindowInfo.current
  val isIos = device.platform == Platform.Ios
  Column(
    modifier =
      Modifier.fillMaxWidth()
        .border(
          width = if (selected) 2.dp else 1.dp,
          color = if (selected) Accent else MaterialTheme.colorScheme.outlineVariant,
          shape = RoundedCornerShape(6.dp),
        )
        .then(
          if (clickable)
            Modifier.clickable {
              // Read the live modifier state at click time (mirrors the repo's Meta/Ctrl handling):
              // Shift or Cmd/Ctrl means "add to selection" rather than "observe now".
              val mods = windowInfo.keyboardModifiers
              onClick(mods.isShiftPressed || mods.isMetaPressed || mods.isCtrlPressed)
            }
          else Modifier,
        )
        .semantics { contentDescription = cardDescription(displayName, booted, booting, error) }
        .padding(12.dp),
  ) {
    thumbnail(device, booting)
    Spacer(Modifier.height(8.dp))
    DeviceCardName(device, displayName)
    Spacer(Modifier.height(4.dp))
    DeviceCardMetadata(device)
    if (!booted) {
      Text(
        bootAffordance(booting, error, finishingPreviousSession),
        style = MaterialTheme.typography.labelSmall,
        color = if (error != null) MaterialTheme.colorScheme.error else Accent,
      )
    }
  }
}

private fun cardDescription(
  displayName: String,
  booted: Boolean,
  booting: Boolean,
  error: String?,
): String =
  when {
    booted -> "Observe $displayName"
    booting -> "Booting $displayName"
    error != null -> "Retry boot $displayName"
    else -> "Boot $displayName"
  }

private fun bootAffordance(
  booting: Boolean,
  error: String?,
  finishingPreviousSession: Boolean = false,
): String =
  when {
    booting && finishingPreviousSession -> "Finishing previous session…"
    booting -> "Booting…"
    error != null -> "Boot failed · Click to retry"
    else -> "Click to boot"
  }

@Composable
private fun DeviceCardName(device: PickerDevice, displayName: String) {
  val isIos = device.platform == Platform.Ios
  Row(verticalAlignment = Alignment.CenterVertically) {
    Icon(
      imageVector = PlatformIcons.logo(isIos),
      contentDescription = null,
      tint = PlatformIcons.tint(isIos),
      modifier = Modifier.size(16.dp),
    )
    Spacer(Modifier.width(6.dp))
    if (displayName == device.name) {
      Text(device.name, style = MaterialTheme.typography.bodyLarge)
    } else {
      Tooltip(tooltip = { Text(device.id) }) {
        Text(displayName, style = MaterialTheme.typography.bodyLarge)
      }
    }
  }
}

@Composable
private fun DeviceCardMetadata(device: PickerDevice) {
  val isIos = device.platform == Platform.Ios
  val meta =
    listOfNotNull(
        if (isIos) "iOS" else "Android",
        device.osLabel,
        device.architecture,
        when (device.state) {
          DeviceState.Booted -> "booted"
          DeviceState.Booting -> "Booting"
          DeviceState.Shutdown -> "Shut down"
        },
      )
      .joinToString(" · ")
  Text(
    meta,
    style = MaterialTheme.typography.bodySmall,
    color = MaterialTheme.colorScheme.onSurfaceVariant,
  )
}
