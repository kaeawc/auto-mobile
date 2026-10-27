@file:OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)

package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.datasource.StorageMutationResult
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

/** Color for highlighting recently changed entries */
internal val HIGHLIGHT_COLOR = Color(0xFF4CAF50).copy(alpha = 0.3f)

internal data class EditingEntryIdentity(
  val filePath: String,
  val key: String,
  val type: KeyValueType,
)

/**
 * Key-Value storage inspector for SharedPreferences (Android) / UserDefaults (iOS).
 *
 * @param keyValueFiles List of key-value storage files to display
 * @param onSetValue Optional callback to persist a value change. Receives (fileName, key, value,
 *   type).
 * @param recentlyChangedKeys Entries to highlight as just-changed, using [highlightKey] identities.
 *   Hoisted so the caller owns both the live-update source and the highlight lifetime; see
 *   [StorageDashboard], which drives this from the observation stream's `storage_update` frames.
 * @param modifier Modifier for the composable
 */
@Composable
fun KeyValueInspector(
  keyValueFiles: List<KeyValueFile>,
  modifier: Modifier = Modifier,
  options: KeyValueInspectorOptions = KeyValueInspectorOptions(),
) {
  val memory = rememberKeyValueMemory()
  with(memory) {
    return with(options) {
      val colors = SharedTheme.globalColors
      val scope = rememberCoroutineScope()

      // State. Selection is tracked by stable identity (the file's path) rather than by the
      // KeyValueFile instance so that a list rebuild -- from an optimistic edit fold or a live
      // storage_update frame -- does not reset the inspector to the first file and hide the value
      // the
      // user just edited (#4709 review). Falls back to the first file when the remembered path is
      // absent: the initial load (no selection yet) or when the selected file disappears from the
      // list.

      val selectedFile =
        keyValueFiles.firstOrNull { it.path == selectedPath } ?: keyValueFiles.firstOrNull()

      // Filter entries by search query
      val filteredEntries =
        remember(selectedFile, searchQuery) {
          selectedFile?.entries?.filter { entry ->
            searchQuery.isEmpty() ||
              entry.key.contains(searchQuery, ignoreCase = true) ||
              entry.value.toString().contains(searchQuery, ignoreCase = true)
          } ?: emptyList()
        }

      Row(modifier = modifier.fillMaxSize()) {
        StorageFiles(memory, keyValueFiles, selectedFile)
        // Divider
        Box(
          modifier =
            Modifier.width(1.dp).fillMaxSize().background(colors.text.normal.copy(alpha = 0.1f)),
        )

        // Right panel: Key-value list
        Column(modifier = Modifier.weight(1f).fillMaxSize()) {
          StorageSearch()
          StorageColumnHeaders()
          // Entry list
          if (filteredEntries.isEmpty()) {
            Box(
              modifier = Modifier.fillMaxSize(),
              contentAlignment = Alignment.Center,
            ) {
              Text(
                if (searchQuery.isEmpty()) "No entries" else "No matching entries",
                fontSize = 12.sp,
                color = colors.text.normal.copy(alpha = 0.5f),
              )
            }
          } else {
            LazyColumn(modifier = Modifier.fillMaxSize()) {
              items(filteredEntries) { entry ->
                StorageEntry(memory, selectedFile, entry, scope)
              }
            }
          }

          // Footer
          StorageFooter(selectedFile, filteredEntries)
        }
      }
    }
  }
}

data class KeyValueInspectorOptions(
  val loadError: String? = null,
  val loadErrorCode: String? = null,
  val onSetValue:
    (suspend (fileName: String, key: String, value: String, type: KeyValueType) -> Result<
        StorageMutationResult,
      >)? =
    null,
  val recentlyChangedKeys: Set<String> = emptySet(),
)

internal data class KeyValueMemory(
  private val selectedPathState: androidx.compose.runtime.MutableState<String?>,
  private val searchQueryState: androidx.compose.runtime.MutableState<String>,
  private val selectedEntryState: androidx.compose.runtime.MutableState<KeyValueEntry?>,
  private val editingEntryState: androidx.compose.runtime.MutableState<EditingEntryIdentity?>,
  private val editValueState: androidx.compose.runtime.MutableState<String>,
  private val isSavingState: androidx.compose.runtime.MutableState<Boolean>,
  private val saveErrorState: androidx.compose.runtime.MutableState<String?>,
  private val saveWarningState: androidx.compose.runtime.MutableState<String?>,
) {
  var selectedPath by selectedPathState
  var searchQuery by searchQueryState
  var selectedEntry by selectedEntryState
  var editingEntry by editingEntryState
  var editValue by editValueState
  var isSaving by isSavingState
  var saveError by saveErrorState
  var saveWarning by saveWarningState
}

@Composable
private fun rememberKeyValueMemory(): KeyValueMemory {
  val selectedPathState = remember { mutableStateOf<String?>(null) }
  val searchQueryState = remember { mutableStateOf("") }
  val selectedEntryState = remember { mutableStateOf<KeyValueEntry?>(null) }
  val editingEntryState = remember { mutableStateOf<EditingEntryIdentity?>(null) }
  val editValueState = remember { mutableStateOf("") }
  val isSavingState = remember { mutableStateOf(false) }
  val saveErrorState = remember { mutableStateOf<String?>(null) }
  val saveWarningState = remember { mutableStateOf<String?>(null) }
  return KeyValueMemory(
    selectedPathState,
    searchQueryState,
    selectedEntryState,
    editingEntryState,
    editValueState,
    isSavingState,
    saveErrorState,
    saveWarningState,
  )
}

@Composable
private fun KeyValueInspectorOptions.StorageFiles(
  memory: KeyValueMemory,
  keyValueFiles: List<KeyValueFile>,
  selectedFile: KeyValueFile?,
) {
  val colors = SharedTheme.globalColors
  with(memory) {
    // Left panel: File list
    Column(
      modifier =
        Modifier.width(200.dp).fillMaxSize().background(colors.text.normal.copy(alpha = 0.02f)),
    ) {
      if (loadError != null) {
        StorageLoadError(loadError, loadErrorCode)
      }
      // Header
      Box(
        modifier =
          Modifier.fillMaxWidth().background(colors.text.normal.copy(alpha = 0.03f)).padding(12.dp),
      ) {
        Text(
          "Storage Files",
          fontSize = 11.sp,
          fontWeight = FontWeight.SemiBold,
          color = colors.text.normal.copy(alpha = 0.7f),
        )
      }

      // File list
      LazyColumn(modifier = Modifier.fillMaxSize()) {
        items(keyValueFiles) { file ->
          val isSelected = file == selectedFile

          StorageFileRow(file, isSelected)
        }
      }
    }
  }
}

@Composable
private fun KeyValueMemory.StorageSearch() {
  val colors = SharedTheme.globalColors
  // Search bar
  Row(
    modifier =
      Modifier.fillMaxWidth().background(colors.text.normal.copy(alpha = 0.03f)).padding(8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      modifier =
        Modifier.weight(1f)
          .height(32.dp)
          .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
          .padding(horizontal = 10.dp),
      contentAlignment = Alignment.CenterStart,
    ) {
      Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Text(
          "\uD83D\uDD0D",
          fontSize = 12.sp,
          color = colors.text.normal.copy(alpha = 0.4f),
        )
        StorageSearchInput(this@StorageSearch)
        if (searchQuery.isNotEmpty()) {
          Text(
            "\u2715",
            fontSize = 10.sp,
            color = colors.text.normal.copy(alpha = 0.5f),
            modifier = Modifier.clickable { searchQuery = "" }.pointerHoverIcon(PointerIcon.Hand),
          )
        }
      }
    }
  }
}

@Composable
private fun StorageColumnHeaders() {
  val colors = SharedTheme.globalColors
  // Column headers
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f))
        .padding(horizontal = 12.dp, vertical = 8.dp),
  ) {
    Text(
      "Key",
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      color = colors.text.normal.copy(alpha = 0.6f),
      modifier = Modifier.weight(0.4f),
    )
    Text(
      "Value",
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      color = colors.text.normal.copy(alpha = 0.6f),
      modifier = Modifier.weight(0.45f),
    )
    Text(
      "Type",
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      color = colors.text.normal.copy(alpha = 0.6f),
      modifier = Modifier.weight(0.15f),
    )
  }

  Box(
    modifier =
      Modifier.fillMaxWidth().height(1.dp).background(colors.text.normal.copy(alpha = 0.1f)),
  )
}

@Composable
private fun StorageFooter(selectedFile: KeyValueFile?, filteredEntries: List<KeyValueEntry>) {
  val colors = SharedTheme.globalColors
  if (selectedFile != null) {
    Row(
      modifier =
        Modifier.fillMaxWidth()
          .background(colors.text.normal.copy(alpha = 0.03f))
          .padding(horizontal = 12.dp, vertical = 6.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
    ) {
      Text(
        selectedFile.path,
        fontSize = 10.sp,
        color = colors.text.normal.copy(alpha = 0.4f),
        fontFamily = FontFamily.Monospace,
      )
      Text(
        "${filteredEntries.size} of ${selectedFile.entries.size} entries",
        fontSize = 10.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
      )
    }
  }
}

internal data class KeyValueEntryContext(
  val selectedFile: KeyValueFile?,
  val entry: KeyValueEntry,
  val scope: kotlinx.coroutines.CoroutineScope,
  val isEditing: Boolean,
  val isSelected: Boolean,
)

@Composable
private fun androidx.compose.foundation.layout.RowScope.StorageSearchInput(memory: KeyValueMemory) {
  val colors = SharedTheme.globalColors
  with(memory) {
    BasicTextField(
      value = searchQuery,
      onValueChange = { searchQuery = it },
      textStyle =
        TextStyle(
          fontSize = 12.sp,
          color = colors.text.normal,
        ),
      cursorBrush = SolidColor(colors.text.normal),
      singleLine = true,
      modifier = Modifier.weight(1f),
      decorationBox = { innerTextField ->
        Box {
          if (searchQuery.isEmpty()) {
            Text(
              "Search keys or values...",
              fontSize = 12.sp,
              color = colors.text.normal.copy(alpha = 0.4f),
            )
          }
          innerTextField()
        }
      },
    )
  }
}
