package dev.jasonpearson.automobile.desktop.core.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.datasource.InstalledApp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/** Searchable app filter section with a text field filter and selectable app list. */
@Composable
fun AppFilterSection(
    installedApps: List<InstalledApp>,
    selectedAppId: String?,
    onAppSelected: (String?) -> Unit,
    modifier: Modifier = Modifier,
) {
  val colors = SharedTheme.globalColors
  var expanded by remember { mutableStateOf(true) }
  var filterText by remember { mutableStateOf("") }

  val filteredApps =
      remember(installedApps, filterText) {
        if (filterText.isBlank()) {
          installedApps
        } else {
          installedApps.filter { app ->
            app.packageName.contains(filterText, ignoreCase = true) ||
                (app.displayName?.contains(filterText, ignoreCase = true) == true)
          }
        }
      }

  Column(
      modifier =
          modifier
              .background(colors.text.normal.copy(alpha = 0.03f), RoundedCornerShape(6.dp))
              .padding(12.dp),
      verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    CollapsibleSectionHeader(
        title = "App Filter",
        expanded = expanded,
        onToggle = { expanded = !expanded },
        trailing = {
          if (installedApps.isNotEmpty()) {
            Text(
                "${installedApps.size}",
                fontSize = 10.sp,
                color = colors.text.normal.copy(alpha = 0.5f),
                maxLines = 1,
                softWrap = false,
            )
          }
        },
    )

    if (expanded) {
      if (installedApps.isEmpty()) {
        Text(
            "No apps available",
            fontSize = 11.sp,
            color = colors.text.normal.copy(alpha = 0.5f),
            maxLines = 1,
            softWrap = false,
        )
      } else {
        // Search field
        TextField(
            value = filterText,
            onValueChange = { filterText = it },
            placeholder = {
              Text(
                  "Search packages...",
                  fontSize = 11.sp,
                  color = colors.text.normal.copy(alpha = 0.35f),
              )
            },
            textStyle =
                TextStyle(
                    fontSize = 11.sp,
                    color = colors.text.normal,
                ),
            singleLine = true,
            colors =
                TextFieldDefaults.colors(
                    focusedContainerColor = colors.text.normal.copy(alpha = 0.05f),
                    unfocusedContainerColor = colors.text.normal.copy(alpha = 0.03f),
                    focusedIndicatorColor = colors.outlines.focused.copy(alpha = 0.5f),
                    unfocusedIndicatorColor = Color.Transparent,
                    cursorColor = colors.outlines.focused,
                ),
            modifier = Modifier.fillMaxWidth(),
        )

        // Clear selection option
        if (selectedAppId != null) {
          Text(
              "Clear selection",
              fontSize = 10.sp,
              color = Color(0xFF2196F3),
              modifier =
                  Modifier.clickable { onAppSelected(null) }.pointerHoverIcon(PointerIcon.Hand),
          )
        }

        // Filtered app list
        filteredApps.forEach { app ->
          val isSelected = app.packageName == selectedAppId
          Row(
              modifier =
                  Modifier.fillMaxWidth()
                      .background(
                          if (isSelected) colors.outlines.focused.copy(alpha = 0.12f)
                          else Color.Transparent,
                          RoundedCornerShape(4.dp),
                      )
                      .clickable { onAppSelected(app.packageName) }
                      .pointerHoverIcon(PointerIcon.Hand)
                      .padding(horizontal = 8.dp, vertical = 3.dp),
              horizontalArrangement = Arrangement.SpaceBetween,
              verticalAlignment = Alignment.CenterVertically,
          ) {
            Column(modifier = Modifier.weight(1f)) {
              Text(
                  app.displayName ?: app.packageName.substringAfterLast('.'),
                  fontSize = 11.sp,
                  fontWeight = if (isSelected) FontWeight.Medium else FontWeight.Normal,
                  color = if (isSelected) colors.outlines.focused else colors.text.normal,
                  maxLines = 1,
                  softWrap = false,
                  overflow = TextOverflow.Ellipsis,
              )
              Text(
                  app.packageName,
                  fontSize = 9.sp,
                  color = colors.text.normal.copy(alpha = 0.45f),
                  maxLines = 1,
                  softWrap = false,
                  overflow = TextOverflow.Ellipsis,
              )
            }
            if (app.isForeground) {
              Text(
                  "FG",
                  fontSize = 9.sp,
                  fontWeight = FontWeight.Bold,
                  color = Color(0xFF4CAF50),
              )
            }
          }
        }

        if (filteredApps.isEmpty() && filterText.isNotBlank()) {
          Text(
              "No matching apps",
              fontSize = 11.sp,
              color = colors.text.normal.copy(alpha = 0.5f),
          )
        }
      }
    }
  }
}
