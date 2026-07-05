package dev.jasonpearson.automobile.desktop.core

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import dev.jasonpearson.automobile.desktop.core.datasource.InstalledApp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
private fun AppSelectorDropdown(
  installedApps: List<InstalledApp>,
  selectedAppId: String?,
  isLoading: Boolean,
  expanded: Boolean,
  onExpandedChange: (Boolean) -> Unit,
  onAppSelected: (String?) -> Unit,
) {
  val colors = SharedTheme.globalColors
  val selectedApp = installedApps.find { it.packageName == selectedAppId }
  val displayText =
    when {
      isLoading -> "Loading..."
      selectedApp != null -> selectedApp.displayName ?: selectedApp.packageName
      selectedAppId != null -> selectedAppId // Show package name if app not in list
      installedApps.isEmpty() -> "No apps"
      else -> "Select app"
    }

  Row(
    horizontalArrangement = Arrangement.spacedBy(6.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      "App:",
      fontSize = 11.sp,
      maxLines = 1,
      softWrap = false,
      color = colors.text.normal.copy(alpha = 0.5f),
    )

    Box {
      Row(
        modifier =
          Modifier.background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
            .border(1.dp, colors.text.normal.copy(alpha = 0.2f), RoundedCornerShape(4.dp))
            .clickable(enabled = !isLoading) { onExpandedChange(!expanded) }
            .pointerHoverIcon(if (isLoading) PointerIcon.Default else PointerIcon.Hand)
            .padding(horizontal = 10.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          displayText,
          fontSize = 11.sp,
          color = colors.text.normal,
          maxLines = 1,
        )

        // Foreground indicator
        if (selectedApp?.isForeground == true) {
          Box(
            modifier =
              Modifier.background(Color(0xFF4CAF50), RoundedCornerShape(2.dp))
                .padding(horizontal = 4.dp, vertical = 1.dp)
          ) {
            Text(
              "FG",
              fontSize = 9.sp,
              color = Color.White,
            )
          }
        }

        Text(
          if (expanded) "\u25B2" else "\u25BC",
          fontSize = 8.sp,
          color = colors.text.normal.copy(alpha = 0.5f),
        )
      }

      // Dropdown popup overlay
      if (expanded) {
        Popup(
          onDismissRequest = { onExpandedChange(false) },
          offset = IntOffset(0, 32),
          properties = PopupProperties(focusable = true),
        ) {
          Column(
            modifier =
              Modifier.width(300.dp)
                .heightIn(max = 200.dp) // Show ~5 items, scroll for more
                .background(Color(0xFF2D2D2D), RoundedCornerShape(4.dp))
                .border(1.dp, Color(0xFF404040), RoundedCornerShape(4.dp))
                .verticalScroll(rememberScrollState())
          ) {
            // Installed apps - foreground first
            val sortedApps = installedApps.sortedByDescending { it.isForeground }
            sortedApps.forEach { app ->
              AppDropdownItem(
                displayName = app.displayName,
                packageName = app.packageName,
                isForeground = app.isForeground,
                isSelected = app.packageName == selectedAppId,
                onClick = {
                  onAppSelected(app.packageName)
                  onExpandedChange(false)
                },
              )
            }
          }
        }
      }
    }
  }
}

@Composable
private fun AppDropdownItem(
  displayName: String?,
  packageName: String?,
  isForeground: Boolean,
  isSelected: Boolean,
  onClick: () -> Unit,
) {
  val colors = SharedTheme.globalColors
  val bgColor = if (isSelected) Color(0xFF2166B3) else Color.Transparent

  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(bgColor)
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 12.dp, vertical = 8.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column(modifier = Modifier.weight(1f)) {
      Text(
        displayName ?: packageName ?: "Unknown",
        fontSize = 12.sp,
        color = colors.text.normal,
      )
      if (packageName != null && displayName != null && displayName != packageName) {
        Text(
          packageName,
          fontSize = 10.sp,
          color = colors.text.normal.copy(alpha = 0.5f),
        )
      }
    }

    if (isForeground) {
      Box(
        modifier =
          Modifier.background(Color(0xFF4CAF50), RoundedCornerShape(2.dp))
            .padding(horizontal = 4.dp, vertical = 1.dp)
      ) {
        Text(
          "FG",
          fontSize = 9.sp,
          color = Color.White,
        )
      }
    }

    if (isSelected) {
      Text(
        "\u2713",
        fontSize = 12.sp,
        color = Color(0xFF4CAF50),
      )
    }
  }
}
