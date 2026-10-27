@file:OptIn(
  androidx.compose.ui.ExperimentalComposeUiApi::class,
  androidx.compose.foundation.ExperimentalFoundationApi::class,
)

package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val LOG = LoggerFactory.getLogger("DatabaseInspector")

internal typealias CellUpdater = suspend (String, String, String?, Map<String, Any?>) -> String?

internal class DatabaseSelection(
  database: androidx.compose.runtime.MutableState<DatabaseInfo?>,
  table: androidx.compose.runtime.MutableState<TableInfo?>,
) {
  var selectedDatabase by database
  var selectedTable by table
}

internal class DatabaseInspectorState {
  var viewMode by mutableStateOf(DatabaseViewMode.Data)
  var queryText by mutableStateOf("")
  var queryResult by mutableStateOf<QueryResult?>(null)
  var savedQueries by mutableStateOf(emptyList<SavedQuery>())
  var queryHistory by mutableStateOf(emptyList<QueryHistoryEntry>())
  var tableData by mutableStateOf<QueryResult?>(null)
  var isLoadingData by mutableStateOf(false)
}

internal class DatabaseInspectorOperations(
  private val actions: DatabaseInspectorActions,
  private val selection: DatabaseSelection,
  private val state: DatabaseInspectorState,
) {
  suspend fun loadTable() {
    val db = selection.selectedDatabase ?: return
    val table = selection.selectedTable ?: return
    val fetch = actions.onFetchTableData ?: return
    state.isLoadingData = true
    state.tableData = null
    try {
      state.tableData =
        databaseCall({ null }) {
          withContext(actions.ioDispatcher) { fetch(db.path, table.name) }
        }
    } finally {
      state.isLoadingData = false
    }
  }

  fun cellUpdater(): CellUpdater? {
    if (actions.onExecuteSQL == null || actions.onFetchTableData == null) return null
    return { tableName, columnName, newValue, pkValues ->
      updateCell(tableName, columnName, newValue, pkValues)
    }
  }

  private suspend fun updateCell(
    tableName: String,
    columnName: String,
    newValue: String?,
    pkValues: Map<String, Any?>,
  ): String? {
    val db = selection.selectedDatabase ?: return "No database selected"
    val execute = requireNotNull(actions.onExecuteSQL) { "Cell updates require SQL execution" }
    val fetch = requireNotNull(actions.onFetchTableData) { "Cell updates require table loading" }
    val set = "\"${columnName.replace("\"", "\"\"")}\" = ${formatSqlValue(newValue)}"
    val where =
      pkValues.entries.joinToString(" AND ") { (col, value) ->
        "\"${col.replace("\"", "\"\"")}\" = ${formatSqlValue(value?.toString())}"
      }
    val sql = "UPDATE \"${tableName.replace("\"", "\"\"")}\" SET $set WHERE $where"
    LOG.info("onUpdateCell: executing SQL: $sql")
    val result = withContext(actions.ioDispatcher) { execute(db.path, sql) }
    if (result.error != null) {
      val message = enrichSqlError(result, db).error ?: "Unknown error"
      LOG.warn("onUpdateCell: update failed: $message\nSQL: $sql")
      return "$message\n\nSQL: $sql"
    }
    // Refresh without toggling loading: DataView must retain its in-flight update coroutine.
    val table = selection.selectedTable
    if (table != null) {
      val refreshed =
        databaseCall({ null }) {
          withContext(actions.ioDispatcher) { fetch(db.path, table.name) }
        }
      if (refreshed != null) state.tableData = refreshed
    }
    return null
  }

  fun executeQuery(scope: kotlinx.coroutines.CoroutineScope) {
    val execute = actions.onExecuteSQL
    if (execute == null || selection.selectedDatabase == null) {
      executeMockQuery()
      return
    }
    scope.launch {
      val db = selection.selectedDatabase ?: return@launch
      executeLiveQuery(execute, db)
    }
  }

  private suspend fun executeLiveQuery(
    execute: suspend (String, String) -> QueryResult,
    db: DatabaseInfo,
  ) {
    val result =
      databaseCall(
        { error ->
          QueryResult(emptyList(), emptyList(), 0, 0, error = error.message ?: "Execution failed")
        },
      ) {
        withContext(actions.ioDispatcher) { execute(db.path, state.queryText) }
      }
    val enriched = enrichSqlError(result, db)
    state.queryResult = enriched
    val entry =
      QueryHistoryEntry(
        id = "h${System.currentTimeMillis()}",
        sql = state.queryText,
        databaseName = db.name,
        executedAt = System.currentTimeMillis(),
        executionTimeMs = enriched.executionTimeMs,
        rowsAffected = enriched.rowCount,
        success = enriched.error == null,
        error = enriched.error,
      )
    state.queryHistory =
      listOf(entry) +
        state.queryHistory.filter {
          it.sql != state.queryText || it.databaseName != db.name
        }
  }

  private fun executeMockQuery() {
    state.queryResult = StorageMockData.mockQueryResult
    state.queryHistory =
      listOf(
        QueryHistoryEntry(
          id = "h${System.currentTimeMillis()}",
          sql = state.queryText,
          databaseName = selection.selectedDatabase?.name ?: "",
          executedAt = System.currentTimeMillis(),
          executionTimeMs = 15,
          rowsAffected = StorageMockData.mockQueryResult.rowCount,
          success = true,
        ),
      ) + state.queryHistory
  }

  fun saveQuery(name: String) {
    state.savedQueries =
      state.savedQueries +
        SavedQuery(
          id = "q${System.currentTimeMillis()}",
          name = name,
          sql = state.queryText,
          databaseName = selection.selectedDatabase?.name ?: "",
          createdAt = System.currentTimeMillis(),
        )
  }
}

/**
 * Expected transport and wire-format failures keep the existing UI fallback; cancellation
 * propagates.
 */
internal suspend fun <T> databaseCall(onFailure: (Exception) -> T, action: suspend () -> T): T =
  try {
    action()
  } catch (error: dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException) {
    LOG.warn("Database operation failed: ${error.message}", error)
    onFailure(error)
  } catch (error: java.io.IOException) {
    LOG.warn("Database I/O failed: ${error.message}", error)
    onFailure(error)
  } catch (error: IllegalArgumentException) {
    LOG.warn("Database response invalid: ${error.message}", error)
    onFailure(error)
  }
