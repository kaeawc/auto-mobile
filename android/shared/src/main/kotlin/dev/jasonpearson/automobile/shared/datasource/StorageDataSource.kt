package dev.jasonpearson.automobile.shared.datasource

import dev.jasonpearson.automobile.shared.storage.DatabaseInfo
import dev.jasonpearson.automobile.shared.storage.KeyValueFile
import dev.jasonpearson.automobile.shared.storage.KeyValueType
import dev.jasonpearson.automobile.shared.storage.QueryResult

interface StorageDataSource {
    suspend fun getDatabases(): Result<List<DatabaseInfo>>
    suspend fun getKeyValueFiles(): Result<List<KeyValueFile>>
    suspend fun setKeyValue(fileName: String, key: String, value: String?, type: KeyValueType): Result<Unit>
    suspend fun removeKeyValue(fileName: String, key: String): Result<Unit>
    suspend fun clearKeyValueFile(fileName: String): Result<Unit>
    suspend fun getTableData(
        databasePath: String,
        table: String,
        limit: Int = 50,
        offset: Int = 0,
    ): Result<QueryResult>
    suspend fun executeSQL(databasePath: String, query: String): Result<QueryResult>
}
