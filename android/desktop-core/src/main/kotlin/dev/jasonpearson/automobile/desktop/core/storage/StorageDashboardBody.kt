package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun StorageDashboardBody(
  options: StorageDashboardOptions,
  data: StorageDashboardData,
  live: StorageLiveUpdates,
  selectedTab: StorageTab,
  onSelectTab: (StorageTab) -> Unit,
) {
  val colors = SharedTheme.globalColors
  with(options) {
    with(data) {
      with(live) {
        Column(modifier = modifier.fillMaxSize()) {
          StorageTabs(selectedTab, onSelectTab)
          // Content
          when (selectedTab) {
            StorageTab.Database -> StorageDatabases(options, data)
            StorageTab.KeyValue -> StorageKeyValues(data, live)
          }
        }
      }
    }
  }
}

@Composable
private fun StorageTabs(selectedTab: StorageTab, onSelectTab: (StorageTab) -> Unit) {
  val colors = SharedTheme.globalColors
  // Tab bar
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f))
        .padding(horizontal = 8.dp, vertical = 6.dp),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    StorageTab.entries.forEach { tab ->
      val isSelected = tab == selectedTab

      Row(
        modifier =
          Modifier.clip(RoundedCornerShape(6.dp))
            .background(
              if (isSelected) colors.text.normal.copy(alpha = 0.1f) else Color.Transparent,
            )
            .clickable { onSelectTab(tab) }
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          tab.icon,
          fontSize = 14.sp,
        )
        Text(
          tab.title,
          fontSize = 12.sp,
          color = if (isSelected) colors.text.normal else colors.text.normal.copy(alpha = 0.6f),
        )
      }
    }
  }
}

@Composable
private fun StorageDatabases(options: StorageDashboardOptions, data: StorageDashboardData) {
  with(options) {
    with(data) {
      val onFetchTableData: (suspend (String, String) -> QueryResult)? =
        remember(dataSource) {
          val ds = dataSource ?: return@remember null
          val callback: suspend (String, String) -> QueryResult = { databasePath, table ->
            when (val r = ds.getTableData(databasePath, table)) {
              is Result.Success -> r.data
              is Result.Error -> QueryResult(emptyList(), emptyList(), 0, 0, error = r.message)
              else -> QueryResult(emptyList(), emptyList(), 0, 0, error = "Failed to load data")
            }
          }
          callback
        }

      val onExecuteSQL: (suspend (String, String) -> QueryResult)? =
        remember(dataSource) {
          val ds = dataSource ?: return@remember null
          val callback: suspend (String, String) -> QueryResult = { databasePath, query ->
            when (val r = ds.executeSQL(databasePath, query)) {
              is Result.Success -> r.data
              is Result.Error -> QueryResult(emptyList(), emptyList(), 0, 0, error = r.message)
              else -> QueryResult(emptyList(), emptyList(), 0, 0, error = "Failed to execute query")
            }
          }
          callback
        }

      DatabaseInspector(
        data =
          DatabaseInspectorData(
            databases = databases,
            platform = platform,
            loadError = if (databases.isEmpty()) databaseError?.message else null,
            loadErrorCode = databaseError?.errorCode,
          ),
        actions = DatabaseInspectorActions(onFetchTableData, onExecuteSQL),
        modifier = Modifier.fillMaxSize(),
      )
    }
  }
}

@Composable
private fun StorageKeyValues(data: StorageDashboardData, live: StorageLiveUpdates) {
  with(data) {
    with(live) {
      KeyValueInspector(
        keyValueFiles = keyValueFiles,
        options =
          KeyValueInspectorOptions(
            loadError = keyValueError?.message,
            loadErrorCode = keyValueError?.errorCode,
            onSetValue =
              dataSource?.let { ds ->
                { fileName, key, value, type ->
                  // Snapshot this key's live-update generation before the suspending save. Value
                  // equality is insufficient: an A -> B -> A live sequence must still win over
                  // the older submitted value when the save completes.
                  val generationKey = highlightKey(fileName, key)
                  val preSaveGeneration = storageUpdateGenerations[generationKey] ?: 0L
                  val result = ds.setKeyValue(fileName, key, value, type)
                  // Optimistic local update: reflect the saved value immediately rather than
                  // leaving
                  // it stale until a live storage_update frame arrives (or the facet is reopened).
                  // A later frame for the same key folds in idempotently over this (#4709). No
                  // highlight — a highlight signals a change that happened *under* the user, not
                  // one
                  // they just made. Skipped when a concurrent live frame already advanced the key.
                  if (result is Result.Success) {
                    keyValueFiles =
                      keyValueFiles.applyKeyValueEditIfGenerationUnchanged(
                        edit =
                          KeyValueEdit(
                            fileName,
                            key,
                            value,
                            type,
                          ),
                        preSaveGeneration,
                        storageUpdateGenerations[generationKey] ?: 0L,
                      )
                  }
                  result
                }
              },
            recentlyChangedKeys = highlightExpiries.keys,
          ),
        modifier = Modifier.fillMaxSize(),
      )
    }
  }
}
