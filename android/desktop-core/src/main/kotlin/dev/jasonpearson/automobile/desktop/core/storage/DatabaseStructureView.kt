@file:OptIn(
  androidx.compose.ui.ExperimentalComposeUiApi::class,
  androidx.compose.foundation.ExperimentalFoundationApi::class,
)

package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.desktop.core.theme.SharedTheme

@Composable
internal fun StructureView(table: TableInfo) {
  val colors = SharedTheme.globalColors

  Column(modifier = Modifier.fillMaxSize().padding(12.dp)) {
    Text(
      "Table: ${table.name}",
      fontSize = 14.sp,
      fontWeight = FontWeight.SemiBold,
      color = colors.text.normal,
    )
    Text(
      "${table.rowCount} rows",
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = 0.5f),
      modifier = Modifier.padding(bottom = 16.dp),
    )

    StructureHeaders()

    Box(
      modifier =
        Modifier.fillMaxWidth().height(1.dp).background(colors.text.normal.copy(alpha = 0.1f)),
    )

    LazyColumn {
      items(table.columns) { column ->
        StructureColumnRow(column)
        Box(
          modifier =
            Modifier.fillMaxWidth().height(1.dp).background(colors.text.normal.copy(alpha = 0.05f)),
        )
      }
    }
  }
}

@Composable
private fun StructureHeaders() {
  val colors = SharedTheme.globalColors
  // Column headers
  Row(
    modifier =
      Modifier.fillMaxWidth()
        .background(colors.text.normal.copy(alpha = 0.05f))
        .padding(vertical = 8.dp, horizontal = 12.dp),
  ) {
    Text(
      "Column",
      fontSize = 11.sp,
      fontWeight = FontWeight.SemiBold,
      modifier = Modifier.weight(0.3f),
    )
    Text(
      "Type",
      fontSize = 11.sp,
      fontWeight = FontWeight.SemiBold,
      modifier = Modifier.weight(0.2f),
    )
    Text(
      "PK",
      fontSize = 11.sp,
      fontWeight = FontWeight.SemiBold,
      modifier = Modifier.weight(0.1f),
    )
    Text(
      "Nullable",
      fontSize = 11.sp,
      fontWeight = FontWeight.SemiBold,
      modifier = Modifier.weight(0.15f),
    )
    Text(
      "Default",
      fontSize = 11.sp,
      fontWeight = FontWeight.SemiBold,
      modifier = Modifier.weight(0.25f),
    )
  }
}

@Composable
private fun StructureColumnRow(column: ColumnInfo) {
  val colors = SharedTheme.globalColors
  Row(
    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp, horizontal = 12.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Row(
      modifier = Modifier.weight(0.3f),
      horizontalArrangement = Arrangement.spacedBy(4.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      if (column.isPrimaryKey) {
        Text("\uD83D\uDD11", fontSize = 10.sp) // Key emoji
      }
      Text(column.name, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
    }
    Text(
      column.type,
      fontSize = 11.sp,
      color = Color(0xFF2196F3),
      fontFamily = FontFamily.Monospace,
      modifier = Modifier.weight(0.2f),
    )
    Text(
      if (column.isPrimaryKey) "\u2713" else "",
      fontSize = 11.sp,
      color = Color(0xFF4CAF50),
      modifier = Modifier.weight(0.1f),
    )
    Text(
      if (column.isNullable) "YES" else "NO",
      fontSize = 11.sp,
      color = if (column.isNullable) colors.text.normal.copy(alpha = 0.5f) else colors.text.normal,
      modifier = Modifier.weight(0.15f),
    )
    Text(
      column.defaultValue ?: "-",
      fontSize = 11.sp,
      color = colors.text.normal.copy(alpha = 0.6f),
      fontFamily = FontFamily.Monospace,
      modifier = Modifier.weight(0.25f),
    )
  }
}
