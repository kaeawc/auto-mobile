@file:OptIn(
  androidx.compose.ui.ExperimentalComposeUiApi::class,
  androidx.compose.foundation.ExperimentalFoundationApi::class,
)

package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.Dispatchers

data class DatabaseInspectorData(
  val databases: List<DatabaseInfo> = StorageMockData.databases,
  val platform: StoragePlatform = StoragePlatform.Android,
  val loadError: String? = null,
  val loadErrorCode: String? = null,
)

data class DatabaseInspectorActions(
  val onFetchTableData: (suspend (databasePath: String, table: String) -> QueryResult)? = null,
  val onExecuteSQL: (suspend (databasePath: String, query: String) -> QueryResult)? = null,
  val ioDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.IO,
)

/** Database Inspector with tabs for Data, Structure, SQL, and Query History. */
@Composable
fun DatabaseInspector(
  data: DatabaseInspectorData = DatabaseInspectorData(),
  actions: DatabaseInspectorActions = DatabaseInspectorActions(),
  modifier: Modifier = Modifier,
) {
  val database =
    remember(data.databases) {
      androidx.compose.runtime.mutableStateOf(data.databases.firstOrNull())
    }
  val table =
    remember(database.value) {
      androidx.compose.runtime.mutableStateOf(database.value?.tables?.firstOrNull())
    }
  val selection = DatabaseSelection(database, table)
  val state = remember { DatabaseInspectorState() }
  val operations = DatabaseInspectorOperations(actions, selection, state)
  LaunchedEffect(selection.selectedTable, selection.selectedDatabase, actions.onFetchTableData) {
    operations.loadTable()
  }
  Column(modifier = modifier.fillMaxSize()) {
    DatabaseSelectors(data.databases, selection, state.viewMode)
    if (data.databases.isEmpty()) DatabaseLoadBanner(data)
    ViewModeTabs(state.viewMode) { state.viewMode = it }
    DatabaseTabsContent(selection, state, operations)
  }
}

@Composable
private fun DatabaseTabsContent(
  selection: DatabaseSelection,
  state: DatabaseInspectorState,
  operations: DatabaseInspectorOperations,
) {
  val scope = rememberCoroutineScope()
  when (state.viewMode) {
    DatabaseViewMode.Data -> DatabaseTableContent(selection, state, operations.cellUpdater())
    DatabaseViewMode.Structure -> {
      val table = selection.selectedTable
      if (table != null) StructureView(table) else EmptyState("Select a table to view structure")
    }
    DatabaseViewMode.SQL ->
      SQLView(
        databaseName = selection.selectedDatabase?.name ?: "",
        state = state,
        actions =
          SqlEditorActions(
            onQueryTextChange = { state.queryText = it },
            onExecute = { operations.executeQuery(scope) },
            onSaveQuery = operations::saveQuery,
            onLoadQuery = { state.queryText = it.sql },
          ),
      )
    DatabaseViewMode.QueryHistory ->
      QueryHistoryView(state.queryHistory) {
        state.queryText = it.sql
        state.viewMode = DatabaseViewMode.SQL
      }
  }
}

@Composable
private fun DatabaseTableContent(
  selection: DatabaseSelection,
  state: DatabaseInspectorState,
  onUpdateCell: CellUpdater?,
) {
  val colors = SharedTheme.globalColors
  val table = selection.selectedTable
  when {
    table == null -> EmptyState("Select a table to view data")
    state.isLoadingData ->
      Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text("Loading…", fontSize = 12.sp, color = colors.text.normal.copy(alpha = 0.5f))
      }
    else -> DataView(table, state.tableData ?: StorageMockData.mockQueryResult, onUpdateCell)
  }
}
