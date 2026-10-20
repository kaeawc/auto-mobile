package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.daemon.encodeResourceUriComponent
import dev.jasonpearson.automobile.desktop.core.storage.KeyValueType
import dev.jasonpearson.automobile.desktop.core.storage.parseKeyValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

internal fun buildDatabasesUri(deviceId: String, packageName: String): String {
  val encodedPackage = encodeResourceUriComponent(packageName)
  return "automobile:devices/$deviceId/databases?appId=$encodedPackage"
}

internal fun buildTablesUri(deviceId: String, databasePath: String, packageName: String): String {
  val encodedPath = encodeResourceUriComponent(databasePath)
  val encodedPackage = encodeResourceUriComponent(packageName)
  return "automobile:devices/$deviceId/databases/$encodedPath/tables?appId=$encodedPackage"
}

internal fun buildTableStructureUri(
  deviceId: String,
  databasePath: String,
  table: String,
  packageName: String,
): String {
  val encodedPath = encodeResourceUriComponent(databasePath)
  val encodedTable = encodeResourceUriComponent(table)
  val encodedPackage = encodeResourceUriComponent(packageName)
  return "automobile:devices/$deviceId/databases/$encodedPath/tables/$encodedTable/structure?appId=$encodedPackage"
}

internal fun buildTableDataUri(options: StorageTablePage): String {
  return with(options) {
    val encodedPath = encodeResourceUriComponent(databasePath)
    val encodedTable = encodeResourceUriComponent(table)
    val encodedPackage = encodeResourceUriComponent(packageName)
    "automobile:devices/$deviceId/databases/$encodedPath/tables/$encodedTable/data?appId=$encodedPackage&limit=$limit&offset=$offset"
  }
}

internal fun buildStorageFilesUri(deviceId: String, packageName: String): String {
  val encodedPackage = encodeResourceUriComponent(packageName)
  return "automobile:devices/$deviceId/storage/$encodedPackage/files"
}

internal fun buildStorageEntriesUri(
  deviceId: String,
  packageName: String,
  fileName: String,
): String {
  val encodedPackage = encodeResourceUriComponent(packageName)
  val encodedFile = encodeResourceUriComponent(fileName)
  return "automobile:devices/$deviceId/storage/$encodedPackage/$encodedFile/entries"
}

internal fun jsonElementToAny(element: JsonElement): Any? {
  return when (element) {
    is JsonNull -> null
    is JsonPrimitive ->
      when {
        element.isString -> element.content
        element.content == "true" || element.content == "false" ->
          element.content.toBooleanStrictOrNull() ?: element.content
        element.content.toLongOrNull() != null -> element.content.toLong()
        element.content.toDoubleOrNull() != null -> element.content.toDouble()
        else -> element.content
      }
    else -> element.toString()
  }
}

internal fun mapKeyValueType(type: String): KeyValueType = KeyValueType.fromProtocolName(type)

internal fun parseValue(jsonValue: String?, type: String): Any? =
  parseKeyValue(jsonValue, mapKeyValueType(type))
