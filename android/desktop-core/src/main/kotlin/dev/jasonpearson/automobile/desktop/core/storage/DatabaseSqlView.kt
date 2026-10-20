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
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

internal data class SqlEditorActions(
  val onQueryTextChange: (String) -> Unit,
  val onExecute: () -> Unit,
  val onSaveQuery: (String) -> Unit,
  val onLoadQuery: (SavedQuery) -> Unit,
)

@Composable
internal fun SQLView(
  databaseName: String,
  state: DatabaseInspectorState,
  actions: SqlEditorActions,
) {
  Column(modifier = Modifier.fillMaxSize()) {
    SqlEditor(state, actions)
    state.queryResult?.let { SqlQueryResult(it) }
  }
}

@Composable
private fun SqlEditor(state: DatabaseInspectorState, actions: SqlEditorActions) {
  Column(modifier = Modifier.fillMaxWidth().padding(12.dp)) {
    SqlQueryField(state.queryText, actions)
    Spacer(Modifier.height(8.dp))
    SqlActionBar(state.savedQueries, actions)
  }
}

@Composable
private fun SqlQueryField(queryText: String, actions: SqlEditorActions) {
  val colors = SharedTheme.globalColors
  // Query input with syntax highlighting
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .height(120.dp)
        .background(colors.text.normal.copy(alpha = 0.05f), RoundedCornerShape(4.dp))
        .border(1.dp, colors.text.normal.copy(alpha = 0.1f), RoundedCornerShape(4.dp))
        .padding(8.dp),
  ) {
    BasicTextField(
      value = queryText,
      onValueChange = actions.onQueryTextChange,
      textStyle =
        TextStyle(
          fontSize = 13.sp,
          color = colors.text.normal,
          fontFamily = FontFamily.Monospace,
        ),
      cursorBrush = SolidColor(colors.text.normal),
      modifier =
        Modifier.fillMaxSize().onKeyEvent { event ->
          // Ctrl/Cmd + Enter to execute
          val enterPressed = event.type == KeyEventType.KeyDown && event.key == Key.Enter
          val executeModifier = event.isCtrlPressed || event.isMetaPressed
          if (enterPressed && executeModifier) {
            actions.onExecute()
            true
          } else false
        },
      decorationBox = { innerTextField -> SqlQueryDecoration(queryText, innerTextField) },
    )
  }
}

@Composable
private fun SqlQueryDecoration(queryText: String, innerTextField: @Composable () -> Unit) {
  val colors = SharedTheme.globalColors

  Box {
    if (queryText.isEmpty()) {
      Text(
        "Enter SQL query... (Ctrl+Enter to execute)",
        fontSize = 13.sp,
        color = colors.text.normal.copy(alpha = 0.4f),
        fontFamily = FontFamily.Monospace,
      )
    }
    // Show syntax-highlighted text
    Text(
      highlightSQL(queryText),
      fontSize = 13.sp,
      fontFamily = FontFamily.Monospace,
      modifier = Modifier.matchParentSize(),
    )
    // Invisible text field for input
    Box(modifier = Modifier.matchParentSize()) {
      innerTextField()
    }
  }
}

@Composable
private fun SqlActionBar(savedQueries: List<SavedQuery>, actions: SqlEditorActions) {
  val colors = SharedTheme.globalColors
  // Action buttons
  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    // Favorite button
    Box(
      modifier =
        Modifier.clip(RoundedCornerShape(4.dp))
          .clickable { actions.onSaveQuery("Query ${savedQueries.size + 1}") }
          .pointerHoverIcon(PointerIcon.Hand)
          .border(1.dp, colors.text.normal.copy(alpha = 0.2f), RoundedCornerShape(4.dp))
          .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
      Text("\u2606", fontSize = 14.sp, color = colors.text.normal.copy(alpha = 0.6f)) // Star
    }

    SavedQueryDropdown(savedQueries, actions.onLoadQuery)

    // Execute button
    Box(
      modifier =
        Modifier.clip(RoundedCornerShape(4.dp))
          .background(Color(0xFF6200EE))
          .clickable { actions.onExecute() }
          .pointerHoverIcon(PointerIcon.Hand)
          .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
      Text("Execute", fontSize = 12.sp, color = Color.White, fontWeight = FontWeight.Medium)
    }
  }
}

@Composable
private fun SavedQueryDropdown(savedQueries: List<SavedQuery>, onLoadQuery: (SavedQuery) -> Unit) {
  val colors = SharedTheme.globalColors
  var showSavedQueries by remember { mutableStateOf(false) }
  // Saved queries dropdown
  Box {
    Row(
      modifier =
        Modifier.clip(RoundedCornerShape(4.dp))
          .clickable { showSavedQueries = !showSavedQueries }
          .pointerHoverIcon(PointerIcon.Hand)
          .border(1.dp, colors.text.normal.copy(alpha = 0.2f), RoundedCornerShape(4.dp))
          .padding(horizontal = 10.dp, vertical = 6.dp),
      horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      Text("Saved queries", fontSize = 11.sp, color = colors.text.normal.copy(alpha = 0.7f))
      Text(
        if (showSavedQueries) "\u25B2" else "\u25BC",
        fontSize = 8.sp,
        color = colors.text.normal.copy(alpha = 0.5f),
      )
    }

    if (showSavedQueries && savedQueries.isNotEmpty()) {
      Popup(
        onDismissRequest = { showSavedQueries = false },
        offset = IntOffset(0, 36),
        properties = PopupProperties(focusable = true),
      ) {
        Column(
          modifier =
            Modifier.width(220.dp)
              .background(Color(0xFF2D2D2D), RoundedCornerShape(4.dp))
              .border(1.dp, Color(0xFF404040), RoundedCornerShape(4.dp)),
        ) {
          savedQueries.forEach { query ->
            SavedQueryItem(query) {
              onLoadQuery(query)
              showSavedQueries = false
            }
          }
        }
      }
    }
  }
}

@Composable
private fun SavedQueryItem(query: SavedQuery, onClick: () -> Unit) {
  Box(
    modifier =
      Modifier.fillMaxWidth()
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .padding(10.dp),
  ) {
    Column {
      Text(query.name, fontSize = 11.sp, color = Color.White)
      Text(
        query.sql.take(40) + if (query.sql.length > 40) "..." else "",
        fontSize = 10.sp,
        color = Color.White.copy(alpha = 0.5f),
        fontFamily = FontFamily.Monospace,
      )
    }
  }
}

@Composable
private fun SqlQueryResult(queryResult: QueryResult) {
  val colors = SharedTheme.globalColors
  // Results

  Box(
    modifier =
      Modifier.fillMaxWidth().height(1.dp).background(colors.text.normal.copy(alpha = 0.1f)),
  )

  val queryError = queryResult.error
  if (queryError != null) {
    Box(
      modifier =
        Modifier.fillMaxWidth().background(Color(0xFFFF5722).copy(alpha = 0.1f)).padding(12.dp),
    ) {
      Text(
        queryError,
        fontSize = 12.sp,
        color = Color(0xFFFF5722),
        fontFamily = FontFamily.Monospace,
      )
    }
  } else {
    DataView(
      table = TableInfo("result", queryResult.rowCount.toLong(), emptyList()),
      result = queryResult,
    )
  }
}
