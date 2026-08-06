package dev.jasonpearson.automobile.desktop.domain

public data class DatabaseInfo(
  val name: String,
  val path: String,
  val sizeBytes: Long,
  val tables: List<TableInfo>,
)

public data class TableInfo(
  val name: String,
  val rowCount: Long,
  val columns: List<ColumnInfo>,
)

public data class ColumnInfo(
  val name: String,
  val type: String,
  val isPrimaryKey: Boolean,
  val isNullable: Boolean,
  val defaultValue: String?,
)

public data class QueryResult(
  val columns: List<String>,
  val rows: List<List<Any?>>,
  val rowCount: Int,
  val executionTimeMs: Long,
  val error: String? = null,
)

public data class SavedQuery(
  val id: String,
  val name: String,
  val sql: String,
  val databaseName: String,
  val createdAt: Long,
)

public data class QueryHistoryEntry(
  val id: String,
  val sql: String,
  val databaseName: String,
  val executedAt: Long,
  val executionTimeMs: Long,
  val rowsAffected: Int,
  val success: Boolean,
  val error: String? = null,
)

public data class KeyValueFile(
  val name: String,
  val path: String,
  val platform: StoragePlatform,
  val entries: List<KeyValueEntry>,
)

public data class KeyValueEntry(
  val key: String,
  val value: Any?,
  val type: KeyValueType,
)

public enum class KeyValueType(public val protocolName: kotlin.String) {
  String("STRING"),
  Int("INT"),
  Long("LONG"),
  Float("FLOAT"),
  Boolean("BOOLEAN"),
  StringSet("STRING_SET"),
  Unknown("UNKNOWN");

  public companion object {
    /**
     * Maps a daemon `valueType` string onto this enum, case-insensitively.
     *
     * The daemon's type union is wider than this enum — it also emits DOUBLE, DATA, DATE, ARRAY and
     * DICTIONARY for iOS — so anything unrecognized becomes [Unknown] rather than failing.
     */
    public fun fromProtocolName(protocolName: kotlin.String): KeyValueType =
      entries.firstOrNull { it.protocolName.equals(protocolName, ignoreCase = true) } ?: Unknown
  }
}

public enum class StoragePlatform(public val protocolName: kotlin.String) {
  Android("android"),
  iOS("ios"),
}

public enum class DatabaseViewMode {
  Data,
  Structure,
  SQL,
  QueryHistory,
}
