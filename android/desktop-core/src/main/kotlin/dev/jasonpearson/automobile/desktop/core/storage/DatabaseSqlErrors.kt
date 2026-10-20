@file:OptIn(
  androidx.compose.ui.ExperimentalComposeUiApi::class,
  androidx.compose.foundation.ExperimentalFoundationApi::class,
)

package dev.jasonpearson.automobile.desktop.core.storage

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

/**
 * Format a value for use in a SQL literal. Strings are single-quoted with internal quotes escaped;
 * numbers are unquoted; null becomes NULL.
 */
internal fun formatSqlValue(value: String?): String {
  if (value == null) return "NULL"
  val asLong = value.toLongOrNull()
  val asDouble = value.toDoubleOrNull()
  return when {
    asLong != null -> asLong.toString()
    asDouble != null -> asDouble.toString()
    else -> "'${value.replace("'", "''")}'"
  }
}

/**
 * Strip the MCP error wrapper from a database error message.
 *
 * Converts "MCP server not available: MCP error -32603: Database error (SqlError): SQL error: ..."
 * into just "SQL error: ..."
 */
internal fun stripMcpWrapper(error: String): String {
  val marker = "Database error ("
  val idx = error.indexOf(marker)
  if (idx >= 0) {
    val closeParen = error.indexOf("):", idx)
    if (closeParen >= 0) {
      return error.substring(closeParen + 2).trim().trimEnd(':').trim()
    }
  }
  return error
}

/** Enrich a SQL error result with schema context (available tables or columns). */
internal fun enrichSqlError(result: QueryResult, database: DatabaseInfo): QueryResult {
  val error = result.error ?: return result
  val cleaned = stripMcpWrapper(error)
  val enriched =
    when {
      cleaned.contains("no such table", ignoreCase = true) -> {
        val tables = database.tables.map { it.name }
        if (tables.isNotEmpty()) "$cleaned\nAvailable tables: ${tables.joinToString(", ")}"
        else cleaned
      }
      cleaned.contains("no such column", ignoreCase = true) -> {
        val columns =
          database.tables.flatMap { table ->
            table.columns.map { col -> "${table.name}.${col.name}" }
          }
        if (columns.isNotEmpty()) "$cleaned\nAvailable columns: ${columns.joinToString(", ")}"
        else cleaned
      }
      else -> cleaned
    }
  return result.copy(error = enriched)
}
