package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.McpConnectionException
import dev.jasonpearson.automobile.desktop.core.daemon.RemoveKeyValueRequest
import dev.jasonpearson.automobile.desktop.core.daemon.SetKeyValueRequest
import dev.jasonpearson.automobile.desktop.core.daemon.decodeToolResponse
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.storage.DatabaseInfo
import dev.jasonpearson.automobile.desktop.core.storage.KeyValueFile
import dev.jasonpearson.automobile.desktop.core.storage.KeyValueType
import dev.jasonpearson.automobile.desktop.core.storage.QueryResult
import dev.jasonpearson.automobile.desktop.core.storage.StoragePlatform
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

private val LOG = LoggerFactory.getLogger("RealStorageDataSource")

/**
 * Real storage data source that fetches from MCP resources.
 *
 * @param clientProvider Function to provide an AutoMobileClient for MCP access
 * @param deviceId The device ID to fetch storage data for
 * @param packageName The package name of the app to inspect
 */
class RealStorageDataSource(
  private val clientProvider: (() -> AutoMobileClient)? = null,
  private val deviceId: String? = null,
  private val packageName: String? = null,
  private val platform: StoragePlatform = StoragePlatform.Android,
  private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : StorageDataSource {
  private val json = Json { ignoreUnknownKeys = true }

  override suspend fun getDatabases(): Result<List<DatabaseInfo>> {
    LOG.info("getDatabases: deviceId=$deviceId, packageName=$packageName")

    val provider =
      clientProvider
        ?: run {
          LOG.warn("getDatabases: No clientProvider")
          return Result.Error(
            IllegalStateException("Not connected to MCP server. Please select a device first."),
          )
        }
    val device =
      deviceId
        ?: run {
          LOG.warn("getDatabases: No deviceId provided")
          return Result.Error(IllegalStateException("No device ID provided"))
        }
    val pkg =
      packageName
        ?: run {
          LOG.warn("getDatabases: No packageName provided")
          return Result.Error(IllegalStateException("No package name provided"))
        }

    return try {
      StorageResourceReader(provider(), device, pkg, platform, json).getDatabases()
    } catch (e: McpConnectionException) {
      LOG.warn("getDatabases: MCP connection error: ${e.message}", e)
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (e: kotlinx.serialization.SerializationException) {
      LOG.warn("getDatabases: Exception: ${e.message}", e)
      Result.Error(e, "Failed to load databases: ${e.message}")
    }
  }

  override suspend fun getTableData(
    databasePath: String,
    table: String,
    limit: Int,
    offset: Int,
  ): Result<QueryResult> {
    LOG.info("getTableData: databasePath=$databasePath, table=$table, limit=$limit, offset=$offset")

    val provider =
      clientProvider ?: return Result.Error(IllegalStateException("Not connected to MCP server."))
    val device = deviceId ?: return Result.Error(IllegalStateException("No device ID provided"))
    val pkg = packageName ?: return Result.Error(IllegalStateException("No package name provided"))

    return try {
      val client = provider()
      val uri =
        buildTableDataUri(
          dev.jasonpearson.automobile.desktop.core.datasource.StorageTablePage(
            device,
            databasePath,
            table,
            pkg,
            limit,
            offset,
          ),
        )
      LOG.info("getTableData: Fetching from URI: $uri")
      val contents = client.readResource(uri)
      val text =
        contents.firstOrNull()?.text
          ?: return Result.Success(QueryResult(emptyList(), emptyList(), 0, 0))

      val response = json.decodeFromString(serializer<McpTableDataResponse>(), text)

      if (response.error != null) {
        return Result.Error(RuntimeException(response.error))
      }

      val rows = response.rows.map { row -> row.map { jsonElementToAny(it) } }
      Result.Success(
        QueryResult(
          columns = response.columns,
          rows = rows,
          rowCount = response.total,
          executionTimeMs = 0,
        ),
      )
    } catch (e: McpConnectionException) {
      LOG.warn("getTableData: MCP connection error: ${e.message}", e)
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (e: kotlinx.serialization.SerializationException) {
      LOG.warn("getTableData: Exception: ${e.message}", e)
      Result.Error(e, "Failed to load table data: ${e.message}")
    }
  }

  override suspend fun executeSQL(databasePath: String, query: String): Result<QueryResult> {
    LOG.info("executeSQL: databasePath=$databasePath, query=$query")

    val provider =
      clientProvider ?: return Result.Error(IllegalStateException("Not connected to MCP server."))
    val device = deviceId ?: return Result.Error(IllegalStateException("No device ID provided"))
    val pkg = packageName ?: return Result.Error(IllegalStateException("No package name provided"))

    return try {
      val client = provider()
      client.setToolEnabled("sqlQuery")
      val arguments = buildJsonObject {
        put("deviceId", device)
        put("appId", pkg)
        put("databasePath", databasePath)
        put("query", query)
      }
      val toolElement = client.callTool("sqlQuery", arguments)
      val sqlResult = decodeToolResponse(json, toolElement, serializer<McpSqlResult>())

      if (sqlResult.error != null) {
        return Result.Success(QueryResult(emptyList(), emptyList(), 0, 0, error = sqlResult.error))
      }

      val queryResult =
        if (sqlResult.type == "mutation") {
          val rowsAffected = sqlResult.rowsAffected ?: 0
          QueryResult(
            columns = listOf("rows_affected"),
            rows = listOf(listOf(rowsAffected)),
            rowCount = rowsAffected,
            executionTimeMs = 0,
          )
        } else {
          val rows = sqlResult.rows.map { row -> row.map { jsonElementToAny(it) } }
          QueryResult(
            columns = sqlResult.columns,
            rows = rows,
            rowCount = rows.size,
            executionTimeMs = 0,
          )
        }
      Result.Success(queryResult)
    } catch (e: McpConnectionException) {
      LOG.warn("executeSQL: MCP connection error: ${e.message}", e)
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (e: kotlinx.serialization.SerializationException) {
      LOG.warn("executeSQL: Exception: ${e.message}", e)
      Result.Error(e, "Failed to execute SQL: ${e.message}")
    }
  }

  override suspend fun getKeyValueFiles(): Result<List<KeyValueFile>> {
    LOG.info(
      "getKeyValueFiles: clientProvider=${if (clientProvider != null) "present" else "null"}, deviceId=$deviceId, packageName=$packageName",
    )

    val provider =
      clientProvider
        ?: run {
          LOG.warn("getKeyValueFiles: No clientProvider")
          return Result.Error(
            IllegalStateException("Not connected to MCP server. Please select a device first."),
          )
        }
    val device =
      deviceId
        ?: run {
          LOG.warn("getKeyValueFiles: No deviceId provided")
          return Result.Error(IllegalStateException("No device ID provided"))
        }
    val pkg =
      packageName
        ?: run {
          LOG.warn("getKeyValueFiles: No packageName provided")
          return Result.Error(IllegalStateException("No package name provided"))
        }

    return try {
      StorageResourceReader(provider(), device, pkg, platform, json).getKeyValueFiles()
    } catch (e: McpConnectionException) {
      LOG.warn("getKeyValueFiles: MCP connection error: ${e.message}", e)
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (e: kotlinx.serialization.SerializationException) {
      LOG.warn("getKeyValueFiles: Exception during fetch: ${e.message}", e)
      Result.Error(e, "Failed to load storage data: ${e.message}")
    }
  }

  override suspend fun setKeyValue(
    fileName: String,
    key: String,
    value: String?,
    type: KeyValueType,
  ): Result<StorageMutationResult> {
    val provider =
      clientProvider ?: return Result.Error(IllegalStateException("Not connected to MCP server."))
    val device = deviceId ?: return Result.Error(IllegalStateException("No device ID provided"))
    val pkg = packageName ?: return Result.Error(IllegalStateException("No package name provided"))

    return try {
      val client = provider()
      withContext(ioDispatcher) {
        val result =
          client.setKeyValue(
            input =
              SetKeyValueRequest(
                deviceId = device,
                appId = pkg,
                fileName = fileName,
                key = key,
                value = value,
                type = type.protocolName,
                platform = platform.protocolName,
              ),
          )
        if (result.success) Result.Success(StorageMutationResult(result.warning))
        else Result.Error(RuntimeException(result.message ?: "Failed to set key value"))
      }
    } catch (e: McpConnectionException) {
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (e: kotlinx.serialization.SerializationException) {
      Result.Error(e, "Failed to set key value: ${e.message}")
    }
  }

  override suspend fun removeKeyValue(
    fileName: String,
    key: String,
  ): Result<StorageMutationResult> {
    val provider =
      clientProvider ?: return Result.Error(IllegalStateException("Not connected to MCP server."))
    val device = deviceId ?: return Result.Error(IllegalStateException("No device ID provided"))
    val pkg = packageName ?: return Result.Error(IllegalStateException("No package name provided"))

    return try {
      val client = provider()
      withContext(ioDispatcher) {
        val result =
          client.removeKeyValue(
            input =
              RemoveKeyValueRequest(
                deviceId = device,
                appId = pkg,
                fileName = fileName,
                key = key,
                platform = platform.protocolName,
              ),
          )
        if (result.success) Result.Success(StorageMutationResult(result.warning))
        else Result.Error(RuntimeException(result.message ?: "Failed to remove key value"))
      }
    } catch (e: McpConnectionException) {
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (e: kotlinx.serialization.SerializationException) {
      Result.Error(e, "Failed to remove key value: ${e.message}")
    }
  }

  override suspend fun clearKeyValueFile(fileName: String): Result<StorageMutationResult> {
    val provider =
      clientProvider ?: return Result.Error(IllegalStateException("Not connected to MCP server."))
    val device = deviceId ?: return Result.Error(IllegalStateException("No device ID provided"))
    val pkg = packageName ?: return Result.Error(IllegalStateException("No package name provided"))

    return try {
      val client = provider()
      withContext(ioDispatcher) {
        val result = client.clearKeyValueFile(device, pkg, fileName, platform.protocolName)
        if (result.success) Result.Success(StorageMutationResult(result.warning))
        else Result.Error(RuntimeException(result.message ?: "Failed to clear key value file"))
      }
    } catch (e: McpConnectionException) {
      Result.Error(e, "MCP server not available: ${e.message}")
    } catch (e: kotlinx.serialization.SerializationException) {
      Result.Error(e, "Failed to clear key value file: ${e.message}")
    }
  }
}
