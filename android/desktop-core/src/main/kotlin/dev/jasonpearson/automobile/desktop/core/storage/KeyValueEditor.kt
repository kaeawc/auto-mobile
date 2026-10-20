@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.launch

@Composable
internal fun KeyValueInspectorOptions.EntryValue(
  memory: KeyValueMemory,
  context: KeyValueEntryContext,
) {
  val colors = SharedTheme.globalColors
  with(context) {
    with(memory) {
      if (isEditing) {
        ValueEditor(memory, context)
      } else {
        Row(
          horizontalArrangement = Arrangement.spacedBy(8.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Text(
            formatValue(entry.value, entry.type),
            fontSize = 11.sp,
            fontFamily = FontFamily.Monospace,
            color = getValueColor(entry.type),
            modifier = Modifier.weight(1f, fill = false),
          )

          if (isSelected) {
            Text(
              "\u270E", // Edit icon
              fontSize = 12.sp,
              color = colors.text.normal.copy(alpha = 0.4f),
              modifier =
                Modifier.clickable {
                    val filePath = selectedFile?.path ?: return@clickable
                    saveWarning = null
                    editingEntry =
                      EditingEntryIdentity(
                        filePath = filePath,
                        key = entry.key,
                        type = entry.type,
                      )
                    editValue = entry.value.toString()
                  }
                  .pointerHoverIcon(PointerIcon.Hand),
            )
          }
        }
      }
    }
  }
}

@Composable
internal fun KeyValueInspectorOptions.ValueEditor(
  memory: KeyValueMemory,
  context: KeyValueEntryContext,
) {
  val colors = SharedTheme.globalColors
  with(context) {
    with(memory) {
      Column {
        StorageValueInput()
        Row(
          modifier = Modifier.padding(top = 4.dp),
          horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          if (onSetValue != null) {
            Text(
              if (isSaving) "..." else "Save",
              fontSize = 10.sp,
              color = if (isSaving) colors.text.normal.copy(alpha = 0.4f) else Color(0xFF4CAF50),
              modifier =
                if (!isSaving)
                  Modifier.clickable {
                      saveStorageEntry(memory, context)
                    }
                    .pointerHoverIcon(PointerIcon.Hand)
                else Modifier,
            )
          }
          Text(
            "Cancel",
            fontSize = 10.sp,
            color = colors.text.normal.copy(alpha = 0.5f),
            modifier =
              Modifier.clickable {
                  editingEntry = null
                  saveError = null
                  saveWarning = null
                }
                .pointerHoverIcon(PointerIcon.Hand),
          )
        }
        saveError?.let { error ->
          Text(
            error,
            fontSize = 9.sp,
            color = Color(0xFFE57373),
            modifier = Modifier.padding(top = 2.dp),
          )
        }
        saveWarning?.let { warning ->
          Text(
            warning,
            fontSize = 9.sp,
            color = Color(0xFFFFB74D),
            modifier = Modifier.padding(top = 2.dp),
          )
        }
      }
    }
  }
}

internal fun KeyValueInspectorOptions.saveStorageEntry(
  memory: KeyValueMemory,
  context: KeyValueEntryContext,
) {
  val setValue = onSetValue ?: return
  with(context) {
    with(memory) {
      val entryToSave = editingEntry ?: return
      val file = selectedFile ?: return
      scope.launch {
        isSaving = true
        saveError = null
        saveWarning = null
        val result =
          setValue(
            file.name,
            entryToSave.key,
            editValue,
            entryToSave.type,
          )
        isSaving = false
        // The user can cancel A or start editing B while A's
        // asynchronous save is in flight. Its outcome belongs
        // only to the editor that submitted it; otherwise A's
        // fallback warning/error appears under B.
        if (editingEntry != entryToSave) return@launch
        when (result) {
          is Result.Success -> {
            saveWarning = result.data.warning
            if (result.data.warning == null) editingEntry = null
          }
          is Result.Error -> {
            saveError = result.message
          }
          is Result.Loading -> Unit
        }
      }
    }
  }
}

@Composable
internal fun KeyValueMemory.StorageValueInput() {
  val colors = SharedTheme.globalColors
  BasicTextField(
    value = editValue,
    onValueChange = { editValue = it },
    textStyle =
      TextStyle(
        fontSize = 11.sp,
        color = colors.text.normal,
        fontFamily = FontFamily.Monospace,
      ),
    cursorBrush = SolidColor(colors.text.normal),
    singleLine = true,
    modifier =
      Modifier.fillMaxWidth()
        .background(
          colors.text.normal.copy(alpha = 0.05f),
          RoundedCornerShape(2.dp),
        )
        .padding(4.dp),
  )
}
