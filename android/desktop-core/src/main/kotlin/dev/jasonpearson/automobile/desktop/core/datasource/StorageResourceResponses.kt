package dev.jasonpearson.automobile.desktop.core.datasource

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// MCP response models for database resources

@Serializable
internal data class McpDatabasesResponse(
  val databases: List<McpDatabaseEntry> = emptyList(),
  val error: String? = null,
  val errorCode: String? = null,
  val errorReason: String? = null,
)

@Serializable
internal data class McpDatabaseEntry(
  val name: String,
  val path: String,
  val sizeBytes: Long = 0,
)

@Serializable
internal data class McpTablesResponse(
  val tables: List<String> = emptyList(),
  val error: String? = null,
  val errorCode: String? = null,
  val errorReason: String? = null,
)

@Serializable
internal data class McpTableStructureResponse(
  val columns: List<McpColumnDef> = emptyList(),
  val error: String? = null,
)

@Serializable
internal data class McpColumnDef(
  val name: String,
  val type: String,
  val nullable: Boolean = true,
  val primaryKey: Boolean = false,
  val defaultValue: String? = null,
)

@Serializable
internal data class McpTableDataResponse(
  val columns: List<String> = emptyList(),
  val rows: List<List<JsonElement>> = emptyList(),
  val total: Int = 0,
  val error: String? = null,
)

@Serializable
internal data class McpSqlResult(
  val type: String = "query",
  val message: String? = null,
  val columns: List<String> = emptyList(),
  val rows: List<List<JsonElement>> = emptyList(),
  val rowsAffected: Int? = null,
  val error: String? = null,
)

// MCP response models for storage (key-value) resources

@Serializable
internal data class McpStorageFilesResponse(
  val deviceId: String? = null,
  val packageName: String? = null,
  val files: List<McpPreferenceFile> = emptyList(),
  val totalCount: Int = 0,
  val lastUpdated: String? = null,
  val error: String? = null,
  val errorCode: String? = null,
  val errorReason: String? = null,
)

@Serializable
internal data class McpPreferenceFile(
  val name: String,
  val path: String,
  val entryCount: Int = 0,
)

@Serializable
internal data class McpStorageEntriesResponse(
  val deviceId: String? = null,
  val packageName: String? = null,
  val fileName: String? = null,
  val entries: List<McpKeyValueEntry> = emptyList(),
  val totalCount: Int = 0,
  val lastUpdated: String? = null,
  val error: String? = null,
  val errorCode: String? = null,
  val errorReason: String? = null,
)

@Serializable
internal data class McpKeyValueEntry(
  val key: String,
  val value: String? = null,
  val type: String,
)
