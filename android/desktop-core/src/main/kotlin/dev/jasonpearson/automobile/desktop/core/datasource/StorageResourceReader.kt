package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.core.storage.ColumnInfo
import dev.jasonpearson.automobile.desktop.core.storage.DatabaseInfo
import dev.jasonpearson.automobile.desktop.core.storage.KeyValueEntry
import dev.jasonpearson.automobile.desktop.core.storage.KeyValueFile
import dev.jasonpearson.automobile.desktop.core.storage.StoragePlatform
import dev.jasonpearson.automobile.desktop.core.storage.TableInfo
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer

internal class StorageResourceReader(
  private val client: AutoMobileClient,
  private val device: String,
  private val pkg: String,
  private val platform: StoragePlatform,
  private val json: Json,
) {
  fun getDatabases(): Result<List<DatabaseInfo>> {
    val uri = buildDatabasesUri(device, pkg)
    LOG.info("getDatabases: Fetching from URI: $uri")
    val text = client.readResource(uri).firstOrNull()?.text ?: return Result.Success(emptyList())
    val response = json.decodeFromString(serializer<McpDatabasesResponse>(), text)
    response.error?.let {
      LOG.warn("getDatabases: Response error: $it")
      return Result.Error(RuntimeException(it), it, response.errorCode, response.errorReason)
    }
    LOG.info("getDatabases: Found ${response.databases.size} databases")
    val databases = ArrayList<DatabaseInfo>()
    for (entry in response.databases) {
      when (val result = readDatabase(entry)) {
        is Result.Success -> databases.add(result.data)
        is Result.Error -> return result
        Result.Loading -> return Result.Loading
      }
    }
    LOG.info("getDatabases: Returning ${databases.size} databases")
    return Result.Success(databases)
  }

  private fun readDatabase(entry: McpDatabaseEntry): Result<DatabaseInfo> {
    val text = client.readResource(buildTablesUri(device, entry.path, pkg)).firstOrNull()?.text
    val response = text?.let { json.decodeFromString(serializer<McpTablesResponse>(), it) }
    response?.error?.let {
      return Result.Error(RuntimeException(it), it, response.errorCode, response.errorReason)
    }
    val names = response?.tables.orEmpty()
    LOG.info("getDatabases: DB ${entry.name} has ${names.size} tables")
    val tables = names.map { name ->
      TableInfo(name = name, rowCount = 0, columns = readColumns(entry.path, name))
    }
    return Result.Success(DatabaseInfo(entry.name, entry.path, entry.sizeBytes, tables))
  }

  private fun readColumns(path: String, table: String): List<ColumnInfo> {
    val text =
      client.readResource(buildTableStructureUri(device, path, table, pkg)).firstOrNull()?.text
        ?: return emptyList()
    val response = json.decodeFromString(serializer<McpTableStructureResponse>(), text)
    return response.columns.map {
      ColumnInfo(
        name = it.name,
        type = it.type,
        isPrimaryKey = it.primaryKey,
        isNullable = it.nullable,
        defaultValue = it.defaultValue,
      )
    }
  }

  fun getKeyValueFiles(): Result<List<KeyValueFile>> {
    LOG.info("getKeyValueFiles: Got client: ${client::class.simpleName}")
    val uri = buildStorageFilesUri(device, pkg)
    LOG.info("getKeyValueFiles: Fetching files from URI: $uri")
    val contents = client.readResource(uri)
    LOG.info("getKeyValueFiles: Got ${contents.size} content items")
    val text = contents.firstOrNull()?.text
    if (text == null) {
      LOG.warn("getKeyValueFiles: No text content in response")
      return Result.Success(emptyList())
    }
    LOG.info("getKeyValueFiles: Response text (first 500 chars): ${text.take(500)}")
    val response = json.decodeFromString(serializer<McpStorageFilesResponse>(), text)
    LOG.info(
      "getKeyValueFiles: Parsed response, files count=${response.files.size}, error=${response.error}",
    )
    response.error?.let {
      LOG.warn("getKeyValueFiles: Response contains error: $it")
      return Result.Error(RuntimeException(it), it, response.errorCode, response.errorReason)
    }
    val files = ArrayList<KeyValueFile>()
    for (file in response.files) {
      when (val result = readKeyValueFile(file)) {
        is Result.Success -> files.add(result.data)
        is Result.Error -> return result
        Result.Loading -> return Result.Loading
      }
    }
    LOG.info("getKeyValueFiles: Returning ${files.size} files")
    return Result.Success(files)
  }

  private fun readKeyValueFile(file: McpPreferenceFile): Result<KeyValueFile> {
    val uri = buildStorageEntriesUri(device, pkg, file.name)
    LOG.info("getKeyValueFiles: Fetching entries for ${file.name} from: $uri")
    val text = client.readResource(uri).firstOrNull()?.text
    val entries =
      if (text == null) {
        LOG.warn("getKeyValueFiles: No entries text for ${file.name}")
        emptyList()
      } else {
        val response = json.decodeFromString(serializer<McpStorageEntriesResponse>(), text)
        LOG.info("getKeyValueFiles: File ${file.name} has ${response.entries.size} entries")
        response.error?.let {
          return Result.Error(RuntimeException(it), it, response.errorCode, response.errorReason)
        }
        response.entries.map {
          KeyValueEntry(
            key = it.key,
            value = parseValue(it.value, it.type),
            type = mapKeyValueType(it.type),
          )
        }
      }
    return Result.Success(
      KeyValueFile(name = file.name, path = file.path, platform = platform, entries = entries),
    )
  }

  companion object {
    private val LOG = LoggerFactory.getLogger("RealStorageDataSource")
  }
}
