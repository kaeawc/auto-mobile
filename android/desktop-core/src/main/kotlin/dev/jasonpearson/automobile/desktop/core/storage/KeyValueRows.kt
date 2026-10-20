@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun TypeBadge(
  type: KeyValueType,
  modifier: Modifier = Modifier,
) {
  val (label, color) =
    when (type) {
      KeyValueType.String -> "Str" to Color(0xFFCE9178)
      KeyValueType.Int -> "Int" to Color(0xFFB5CEA8)
      KeyValueType.Long -> "Long" to Color(0xFFB5CEA8)
      KeyValueType.Float -> "Float" to Color(0xFFB5CEA8)
      KeyValueType.Boolean -> "Bool" to Color(0xFF569CD6)
      KeyValueType.StringSet -> "Set" to Color(0xFFDCDCAA)
      KeyValueType.Unknown -> "?" to Color.Gray
    }

  Box(
    modifier = modifier,
    contentAlignment = Alignment.CenterStart,
  ) {
    Box(
      modifier =
        Modifier.clip(RoundedCornerShape(3.dp))
          .background(color.copy(alpha = 0.15f))
          .padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
      Text(
        label,
        fontSize = 9.sp,
        color = color,
        fontWeight = FontWeight.Medium,
      )
    }
  }
}

internal fun formatValue(value: Any?, type: KeyValueType): String {
  return when {
    value == null -> "null"
    type == KeyValueType.String -> "\"$value\""
    type == KeyValueType.Boolean -> if (value == true) "true" else "false"
    type == KeyValueType.StringSet ->
      (value as? Set<*>)?.joinToString(", ", "[", "]") ?: value.toString()
    else -> value.toString()
  }
}

@Composable
internal fun getValueColor(type: KeyValueType): Color {
  return when (type) {
    KeyValueType.String -> Color(0xFFCE9178)
    KeyValueType.Int,
    KeyValueType.Long,
    KeyValueType.Float -> Color(0xFFB5CEA8)
    KeyValueType.Boolean -> Color(0xFF569CD6)
    KeyValueType.StringSet -> Color(0xFFDCDCAA)
    KeyValueType.Unknown -> MaterialTheme.colorScheme.onSurface
  }
}

@Composable
internal fun KeyValueInspectorOptions.StorageEntry(
  memory: KeyValueMemory,
  selectedFile: KeyValueFile?,
  entry: KeyValueEntry,
  scope: kotlinx.coroutines.CoroutineScope,
) {
  val colors = SharedTheme.globalColors
  with(memory) {
    val isSelected = entry == selectedEntry
    val isEditing =
      editingEntry?.let {
        it.filePath == selectedFile?.path && it.key == entry.key && it.type == entry.type
      } == true

    // Check if this entry was recently changed
    val changeKey = highlightKey(selectedFile?.name.orEmpty(), entry.key)
    val isRecentlyChanged = changeKey in recentlyChangedKeys

    // Animate background color for recently changed entries
    val backgroundColor by
      animateColorAsState(
        targetValue =
          when {
            isRecentlyChanged -> HIGHLIGHT_COLOR
            isSelected -> Color(0xFF2196F3).copy(alpha = 0.1f)
            else -> Color.Transparent
          },
        animationSpec = tween(durationMillis = 300),
        label = "entryBackground",
      )

    Row(
      modifier =
        Modifier.fillMaxWidth()
          .clickable {
            selectedEntry = entry
            editingEntry = null
            saveWarning = null
          }
          .pointerHoverIcon(PointerIcon.Hand)
          .background(backgroundColor)
          .padding(horizontal = 12.dp, vertical = 10.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      // Key
      Text(
        entry.key,
        fontSize = 11.sp,
        fontFamily = FontFamily.Monospace,
        color = colors.text.normal,
        modifier = Modifier.weight(0.4f),
      )

      // Value (editable if selected)
      Box(modifier = Modifier.weight(0.45f)) {
        EntryValue(memory, KeyValueEntryContext(selectedFile, entry, scope, isEditing, isSelected))
      }

      // Type badge
      TypeBadge(
        type = entry.type,
        modifier = Modifier.weight(0.15f),
      )
    }

    Box(
      modifier =
        Modifier.fillMaxWidth().height(1.dp).background(colors.text.normal.copy(alpha = 0.05f)),
    )
  }
}

@Composable
internal fun KeyValueMemory.StorageFileRow(file: KeyValueFile, isSelected: Boolean) {
  val colors = SharedTheme.globalColors
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .clickable { selectedPath = file.path }
        .pointerHoverIcon(PointerIcon.Hand)
        .background(
          if (isSelected) colors.text.normal.copy(alpha = 0.08f) else Color.Transparent,
        )
        .padding(horizontal = 12.dp, vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    // Platform icon
    Text(
      if (file.platform == StoragePlatform.Android) "\uD83E\uDD16" else "\uD83C\uDF4E",
      fontSize = 12.sp,
    )

    Column(modifier = Modifier.weight(1f)) {
      Text(
        file.name,
        fontSize = 11.sp,
        color = if (isSelected) colors.text.normal else colors.text.normal.copy(alpha = 0.8f),
      )
      Text(
        "${file.entries.size} entries",
        fontSize = 10.sp,
        color = colors.text.normal.copy(alpha = 0.4f),
      )
    }
  }
}
