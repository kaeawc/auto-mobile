package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.storage.DatabaseInfo
import dev.jasonpearson.automobile.desktop.core.storage.KeyValueFile
import dev.jasonpearson.automobile.desktop.core.storage.KeyValueType
import dev.jasonpearson.automobile.desktop.core.storage.QueryResult

data class StorageMutationResult(val warning: String? = null)

interface StorageDataSource {
  suspend fun getDatabases(): Result<List<DatabaseInfo>>

  suspend fun getKeyValueFiles(): Result<List<KeyValueFile>>

  suspend fun setKeyValue(
    fileName: String,
    key: String,
    value: String?,
    type: KeyValueType,
  ): Result<StorageMutationResult>

  suspend fun removeKeyValue(fileName: String, key: String): Result<StorageMutationResult>

  suspend fun clearKeyValueFile(fileName: String): Result<StorageMutationResult>

  suspend fun getTableData(
    databasePath: String,
    table: String,
    limit: Int = 50,
    offset: Int = 0,
  ): Result<QueryResult>

  suspend fun executeSQL(databasePath: String, query: String): Result<QueryResult>
}
