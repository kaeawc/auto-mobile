@file:OptIn(
  androidx.compose.ui.ExperimentalComposeUiApi::class,
  androidx.compose.foundation.ExperimentalFoundationApi::class,
)

package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme
import kotlinx.coroutines.launch

@Composable
internal fun DataView(table: TableInfo, result: QueryResult, onUpdateCell: CellUpdater? = null) {
  val scrollState = rememberScrollState()
  val editing = remember { TableEditingState() }
  val pkColIndices =
    remember(table.columns, result.columns) {
      table.columns
        .filter { it.isPrimaryKey }
        .mapNotNull { pk -> result.columns.indexOf(pk.name).takeIf { it >= 0 } }
        .toSet()
    }
  val canEdit = onUpdateCell != null && pkColIndices.isNotEmpty()
  val context = TableDataContext(table, result, pkColIndices, canEdit, scrollState, onUpdateCell)
  Column(modifier = Modifier.fillMaxSize()) {
    DataHeader(result, pkColIndices, scrollState)
    DataDivider(0.1f)
    DataRows(context, editing)
    DataUpdateError(editing)
    DataFooter(result, canEdit)
  }
}

private data class TableDataContext(
  val table: TableInfo,
  val result: QueryResult,
  val pkColIndices: Set<Int>,
  val canEdit: Boolean,
  val scrollState: androidx.compose.foundation.ScrollState,
  val onUpdateCell: CellUpdater?,
)

private data class DataCellContext(
  val tableName: String,
  val columnName: String?,
  val rowIndex: Int,
  val colIndex: Int,
  val cell: Any?,
  val pkValues: Map<String, Any?>,
  val isPk: Boolean,
  val canEdit: Boolean,
) {
  val coordinate: Pair<Int, Int>
    get() = rowIndex to colIndex
}

private class TableEditingState {
  var editingCell by mutableStateOf<Pair<Int, Int>?>(null)
  var editText by mutableStateOf("")
  var updatingCell by mutableStateOf<Pair<Int, Int>?>(null)
  var cellUpdateError by mutableStateOf<Triple<Int, Int, String>?>(null)

  fun hasError(cell: DataCellContext): Boolean =
    cellUpdateError?.let { it.first == cell.rowIndex && it.second == cell.colIndex } == true

  fun beginEdit(cell: DataCellContext) {
    editText = cell.cell?.toString() ?: ""
    editingCell = cell.coordinate
    if (hasError(cell)) cellUpdateError = null
  }

  fun handleKey(
    event: androidx.compose.ui.input.key.KeyEvent,
    cell: DataCellContext,
    update: CellUpdater?,
    scope: kotlinx.coroutines.CoroutineScope,
  ): Boolean =
    when {
      event.type == KeyEventType.KeyDown && event.key == Key.Enter -> {
        if (cell.columnName == null) false
        else {
          saveCell(cell, update, scope)
          true
        }
      }
      event.type == KeyEventType.KeyDown && event.key == Key.Escape -> {
        editingCell = null
        true
      }
      else -> false
    }

  private fun saveCell(
    cell: DataCellContext,
    update: CellUpdater?,
    scope: kotlinx.coroutines.CoroutineScope,
  ) {
    val column = requireNotNull(cell.columnName) { "Saving a cell requires a column name" }
    val newValue = editText.takeUnless { it.equals("NULL", ignoreCase = true) }
    editingCell = null
    scope.launch {
      updatingCell = cell.coordinate
      cellUpdateError = null
      val message =
        databaseCall({ it.message ?: "Unknown error" }) {
          val updater = requireNotNull(update) { "Editing a cell requires an update callback" }
          updater(cell.tableName, column, newValue, cell.pkValues)
        }
      updatingCell = null
      if (message != null) cellUpdateError = Triple(cell.rowIndex, cell.colIndex, message)
    }
  }
}

@Composable
private fun DataHeader(
  result: QueryResult,
  pkColIndices: Set<Int>,
  scrollState: androidx.compose.foundation.ScrollState,
) {
  val colors = SharedTheme.globalColors
  // Table header
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.05f))
        .horizontalScroll(scrollState)
        .padding(vertical = 8.dp),
  ) {
    result.columns.forEachIndexed { colIndex, column ->
      Box(modifier = Modifier.width(150.dp).padding(horizontal = 8.dp)) {
        Row(
          horizontalArrangement = Arrangement.spacedBy(4.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          if (colIndex in pkColIndices) {
            Text("\uD83D\uDD11", fontSize = 9.sp)
          }
          Text(
            column,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            color = colors.text.normal,
          )
        }
      }
    }
  }
}

@Composable
private fun DataDivider(alpha: Float) {
  val colors = SharedTheme.globalColors
  Box(
    modifier =
      Modifier.fillMaxWidth().height(1.dp).background(colors.text.normal.copy(alpha = alpha)),
  )
}

@Composable
private fun DataRows(context: TableDataContext, editing: TableEditingState) {
  val scope = rememberCoroutineScope()
  LazyColumn(modifier = Modifier.fillMaxSize()) {
    itemsIndexed(context.result.rows) { rowIndex, row ->
      val pkValues =
        context.pkColIndices.associate { index ->
          (context.result.columns.getOrNull(index) ?: "") to row.getOrNull(index)
        }
      Row(
        modifier =
          Modifier.fillMaxWidth().horizontalScroll(context.scrollState).padding(vertical = 4.dp),
      ) {
        row.forEachIndexed { colIndex, cell ->
          DataCell(
            DataCellContext(
              context.table.name,
              context.result.columns.getOrNull(colIndex),
              rowIndex,
              colIndex,
              cell,
              pkValues,
              colIndex in context.pkColIndices,
              context.canEdit,
            ),
            editing,
            context.onUpdateCell,
            scope,
          )
        }
      }
      DataDivider(0.05f)
    }
  }
}

@Composable
private fun DataCell(
  cell: DataCellContext,
  editing: TableEditingState,
  update: CellUpdater?,
  scope: kotlinx.coroutines.CoroutineScope,
) {
  Box(modifier = Modifier.width(150.dp).padding(horizontal = 8.dp, vertical = 2.dp)) {
    if (editing.editingCell == cell.coordinate) {
      CellEditor(cell, editing, update, scope)
    } else {
      CellReadout(cell, editing)
    }
  }
}

@Composable
private fun CellEditor(
  cell: DataCellContext,
  editing: TableEditingState,
  update: CellUpdater?,
  scope: kotlinx.coroutines.CoroutineScope,
) {
  val colors = SharedTheme.globalColors
  BasicTextField(
    value = editing.editText,
    onValueChange = { editing.editText = it },
    textStyle =
      TextStyle(fontSize = 11.sp, color = colors.text.normal, fontFamily = FontFamily.Monospace),
    cursorBrush = SolidColor(colors.text.normal),
    singleLine = true,
    modifier =
      Modifier.fillMaxWidth()
        .background(Color(0xFF2196F3).copy(alpha = 0.1f), RoundedCornerShape(2.dp))
        .border(1.dp, Color(0xFF2196F3).copy(alpha = 0.6f), RoundedCornerShape(2.dp))
        .padding(2.dp)
        .onKeyEvent { event -> editing.handleKey(event, cell, update, scope) },
  )
}

@Composable
private fun CellReadout(cell: DataCellContext, editing: TableEditingState) {
  val colors = SharedTheme.globalColors
  val isUpdating = editing.updatingCell == cell.coordinate
  Text(
    text = if (isUpdating) "…" else cell.cell?.toString() ?: "NULL",
    fontSize = 11.sp,
    color =
      when {
        isUpdating -> Color(0xFF2196F3).copy(alpha = 0.7f)
        editing.hasError(cell) -> Color(0xFFFF5722)
        cell.cell == null -> colors.text.normal.copy(alpha = 0.4f)
        cell.isPk -> colors.text.normal.copy(alpha = 0.6f)
        else -> colors.text.normal
      },
    fontFamily = FontFamily.Monospace,
    modifier =
      if (cell.canEdit && !cell.isPk) {
        Modifier.clickable { editing.beginEdit(cell) }.pointerHoverIcon(PointerIcon.Text)
      } else Modifier,
  )
}

@Composable
private fun DataUpdateError(editing: TableEditingState) {
  val colors = SharedTheme.globalColors
  // Error banner
  val currentError = editing.cellUpdateError
  if (currentError != null) {
    Row(
      modifier =
        Modifier.fillMaxWidth()
          .background(Color(0xFFFF5722).copy(alpha = 0.12f))
          .padding(horizontal = 12.dp, vertical = 6.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        "Update failed: ${currentError.third}",
        fontSize = 11.sp,
        color = Color(0xFFFF5722),
        fontFamily = FontFamily.Monospace,
        modifier = Modifier.weight(1f),
      )
      Text(
        "\u2715",
        fontSize = 12.sp,
        color = Color(0xFFFF5722).copy(alpha = 0.7f),
        modifier =
          Modifier.clickable { editing.cellUpdateError = null }
            .pointerHoverIcon(PointerIcon.Hand)
            .padding(4.dp),
      )
    }
  }
}

@Composable
private fun DataFooter(result: QueryResult, canEdit: Boolean) {
  val colors = SharedTheme.globalColors
  // Footer
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.03f))
        .padding(horizontal = 12.dp, vertical = 6.dp),
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    Text(
      buildString {
        append("${result.rowCount} rows")
        if (canEdit) append("  •  Click cell to edit, Enter to save, Esc to cancel")
      },
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )
    Text(
      "Executed in ${result.executionTimeMs}ms",
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )
  }
}
