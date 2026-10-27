@file:OptIn(
  androidx.compose.ui.ExperimentalComposeUiApi::class,
  androidx.compose.foundation.ExperimentalFoundationApi::class,
)

package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.foundation.ExperimentalFoundationApi
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerIcon
import androidx.compose.ui.input.pointer.pointerHoverIcon
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun QueryHistoryView(
  history: List<QueryHistoryEntry>,
  onLoadQuery: (QueryHistoryEntry) -> Unit,
) {
  val colors = SharedTheme.globalColors

  LazyColumn(modifier = Modifier.fillMaxSize().padding(12.dp)) {
    items(history) { entry ->
      QueryHistoryRow(entry) { onLoadQuery(entry) }
      Box(
        modifier =
          Modifier.fillMaxWidth().height(1.dp).background(colors.text.normal.copy(alpha = 0.05f)),
      )
    }
  }
}

@Composable
internal fun EmptyState(message: String) {
  val colors = SharedTheme.globalColors

  Box(
    modifier = Modifier.fillMaxSize(),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      message,
      fontSize = 12.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )
  }
}

@Composable
private fun QueryHistoryRow(entry: QueryHistoryEntry, onClick: () -> Unit) {
  val colors = SharedTheme.globalColors
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .clip(RoundedCornerShape(4.dp))
        .clickable(onClick = onClick)
        .pointerHoverIcon(PointerIcon.Hand)
        .background(
          if (entry.success) Color.Transparent else Color(0xFFFF5722).copy(alpha = 0.05f),
        )
        .padding(12.dp),
    horizontalArrangement = Arrangement.SpaceBetween,
    verticalAlignment = Alignment.Top,
  ) {
    Column(modifier = Modifier.weight(1f)) {
      Text(
        entry.sql,
        fontSize = 11.sp,
        fontFamily = FontFamily.Monospace,
        color = colors.text.normal,
      )
      QueryHistoryMetadata(entry)
      val entryError = entry.error
      if (!entry.success && entryError != null) {
        Text(
          entryError,
          fontSize = 10.sp,
          color = Color(0xFFFF5722),
          modifier = Modifier.padding(top = 4.dp),
        )
      }
    }
    Text(
      if (entry.success) "\u2713" else "\u2717",
      fontSize = 14.sp,
      color = if (entry.success) Color(0xFF4CAF50) else Color(0xFFFF5722),
    )
  }
}

@Composable
private fun QueryHistoryMetadata(entry: QueryHistoryEntry) {
  val colors = SharedTheme.globalColors
  Row(
    horizontalArrangement = Arrangement.spacedBy(12.dp),
    modifier = Modifier.padding(top = 4.dp),
  ) {
    Text(
      entry.databaseName,
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )
    Text(
      "${entry.executionTimeMs}ms",
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )
    Text(
      "${entry.rowsAffected} rows",
      fontSize = 10.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
    )
  }
}
