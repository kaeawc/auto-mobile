@file:OptIn(
  androidx.compose.ui.ExperimentalComposeUiApi::class,
  androidx.compose.foundation.ExperimentalFoundationApi::class,
)

package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle

private val SQL_KEYWORDS =
  setOf(
    "SELECT",
    "FROM",
    "WHERE",
    "AND",
    "OR",
    "NOT",
    "IN",
    "LIKE",
    "BETWEEN",
    "ORDER",
    "BY",
    "ASC",
    "DESC",
    "LIMIT",
    "OFFSET",
    "GROUP",
    "HAVING",
    "JOIN",
    "LEFT",
    "RIGHT",
    "INNER",
    "OUTER",
    "ON",
    "AS",
    "INSERT",
    "INTO",
    "VALUES",
    "UPDATE",
    "SET",
    "DELETE",
    "CREATE",
    "TABLE",
    "INDEX",
    "DROP",
    "ALTER",
    "ADD",
    "COLUMN",
    "PRIMARY",
    "KEY",
    "FOREIGN",
    "REFERENCES",
    "UNIQUE",
    "NULL",
    "DEFAULT",
    "COUNT",
    "SUM",
    "AVG",
    "MIN",
    "MAX",
    "DISTINCT",
  )

/** Basic SQL syntax highlighting. */
internal fun highlightSQL(sql: String): AnnotatedString {
  return buildAnnotatedString {
    val words = sql.split(Regex("(\\s+|(?=[,()]))"))
    var index = 0

    for (word in words) {
      val startIndex = sql.indexOf(word, index)
      if (startIndex > index) {
        // Add any skipped whitespace/punctuation
        append(sql.substring(index, startIndex))
      }

      when {
        word.uppercase() in SQL_KEYWORDS -> {
          withStyle(SpanStyle(color = Color(0xFF569CD6), fontWeight = FontWeight.Bold)) {
            append(word)
          }
        }
        word.startsWith("'") || word.startsWith("\"") -> {
          withStyle(SpanStyle(color = Color(0xFFCE9178))) {
            append(word)
          }
        }
        word.toIntOrNull() != null || word.toDoubleOrNull() != null -> {
          withStyle(SpanStyle(color = Color(0xFFB5CEA8))) {
            append(word)
          }
        }
        else -> {
          append(word)
        }
      }

      index = startIndex + word.length
    }

    // Add any remaining text
    if (index < sql.length) {
      append(sql.substring(index))
    }
  }
}
