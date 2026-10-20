@file:OptIn(
  androidx.compose.ui.ExperimentalComposeUiApi::class,
  androidx.compose.foundation.ExperimentalFoundationApi::class,
)

package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun <T> DropdownSelector(
  items: List<T>,
  selectedItem: T?,
  onItemSelected: (T?) -> Unit,
  itemLabel: (T?) -> String,
) {
  var expanded by remember { mutableStateOf(false) }

  Box {
    DropdownButton(itemLabel(selectedItem), expanded) { expanded = !expanded }

    if (expanded) {
      Popup(
        onDismissRequest = { expanded = false },
        offset = IntOffset(0, 36),
        properties = PopupProperties(focusable = true),
      ) {
        Column(
          modifier =
            Modifier.width(180.dp)
              .background(Color(0xFF2D2D2D), RoundedCornerShape(4.dp))
              .border(1.dp, Color(0xFF404040), RoundedCornerShape(4.dp)),
        ) {
          items.forEach { item ->
            Box(
              modifier =
                Modifier.fillMaxWidth()
                  .clickable {
                    onItemSelected(item)
                    expanded = false
                  }
                  .pointerHoverIcon(PointerIcon.Hand)
                  .background(
                    if (item == selectedItem) Color(0xFF2196F3).copy(alpha = 0.3f)
                    else Color.Transparent,
                  )
                  .padding(horizontal = 12.dp, vertical = 10.dp),
            ) {
              Text(
                itemLabel(item),
                fontSize = 12.sp,
                color = Color.White,
              )
            }
          }
        }
      }
    }
  }
}

@Composable
internal fun ViewModeTabs(
  selectedMode: DatabaseViewMode,
  onModeSelected: (DatabaseViewMode) -> Unit,
) {
  val colors = SharedTheme.globalColors

  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.02f))
        .padding(horizontal = 8.dp, vertical = 4.dp),
    horizontalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    DatabaseViewMode.entries.forEach { mode ->
      val isSelected = mode == selectedMode
      val (icon, label) =
        when (mode) {
          DatabaseViewMode.Data -> "\u2637" to "Data"
          DatabaseViewMode.Structure -> "\u2699" to "Structure"
          DatabaseViewMode.SQL -> "\u2318" to "SQL"
          DatabaseViewMode.QueryHistory -> "\u23F1" to "History"
        }

      Row(
        modifier =
          Modifier.clip(RoundedCornerShape(4.dp))
            .background(
              if (isSelected) colors.text.normal.copy(alpha = 0.1f) else Color.Transparent,
            )
            .clickable { onModeSelected(mode) }
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          icon,
          fontSize = 12.sp,
          color = if (isSelected) colors.text.normal else colors.text.normal.copy(alpha = 0.5f),
        )
        Text(
          label,
          fontSize = 11.sp,
          color = if (isSelected) colors.text.normal else colors.text.normal.copy(alpha = 0.5f),
        )
      }
    }
  }
}

@Composable
internal fun DatabaseSelectors(
  databases: List<DatabaseInfo>,
  selection: DatabaseSelection,
  viewMode: DatabaseViewMode,
) {
  val colors = SharedTheme.globalColors
  // Database and Table selectors
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f))
        .padding(horizontal = 12.dp, vertical = 8.dp),
    horizontalArrangement = Arrangement.spacedBy(16.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    LabeledDropdown(
      "DATABASE",
      databases,
      selection.selectedDatabase,
      {
        selection.selectedDatabase = it
        selection.selectedTable = it?.tables?.firstOrNull()
      },
      { it?.name ?: "None" },
    )
    if (viewMode == DatabaseViewMode.Data || viewMode == DatabaseViewMode.Structure) {
      LabeledDropdown(
        "TABLE",
        selection.selectedDatabase?.tables ?: emptyList(),
        selection.selectedTable,
        { selection.selectedTable = it },
        { it?.name ?: "None" },
      )
    }
  }
}

@Composable
internal fun DatabaseLoadBanner(data: DatabaseInspectorData) {
  val colors = SharedTheme.globalColors
  val isError = data.loadError != null
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .background(
          if (isError) Color(0xFFFF5722).copy(alpha = 0.1f)
          else Color(0xFF2196F3).copy(alpha = 0.1f),
        )
        .padding(12.dp),
  ) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text(
        if (isError) "Failed to load databases" else "No databases detected",
        fontSize = 12.sp,
        fontWeight = FontWeight.Medium,
        color = if (isError) Color(0xFFFF5722) else Color(0xFF2196F3),
      )
      if (data.loadError != null) {
        StorageLoadError(data.loadError, data.loadErrorCode)
      } else {
        Text(
          if (data.platform == StoragePlatform.iOS) {
            "AutoMobile can inspect databases in a Simulator app's data container. The SDK provides a richer inspection experience with live updates."
          } else {
            "AutoMobile can inspect databases via adb shell for debuggable apps. The SDK provides a richer inspection experience with live updates."
          },
          fontSize = 11.sp,
          color = colors.text.normal.copy(alpha = 0.7f),
        )
      }
    }
  }
}

@Composable
private fun DropdownButton(label: String, expanded: Boolean, onClick: () -> Unit) {
  val colors = SharedTheme.globalColors
  Row(
    modifier =
      Modifier.clip(RoundedCornerShape(4.dp))
        .background(colors.text.normal.copy(alpha = 0.08f))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(horizontal = 10.dp, vertical = 6.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(label, fontSize = 12.sp, color = colors.text.normal)
    Text(
      if (expanded) "\u25B2" else "\u25BC",
      fontSize = 8.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )
  }
}

@Composable
private fun <T> LabeledDropdown(
  label: String,
  items: List<T>,
  selectedItem: T?,
  onItemSelected: (T?) -> Unit,
  itemLabel: (T?) -> String,
) {
  val colors = SharedTheme.globalColors
  Row(
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(label, fontSize = 10.sp, color = colors.text.normal.copy(alpha = 0.5f))
    DropdownSelector(items, selectedItem, onItemSelected, itemLabel)
  }
}
