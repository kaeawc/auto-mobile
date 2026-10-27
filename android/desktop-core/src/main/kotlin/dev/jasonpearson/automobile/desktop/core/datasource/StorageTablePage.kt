package dev.jasonpearson.automobile.desktop.core.datasource

data class StorageTablePage(
  val deviceId: String,
  val databasePath: String,
  val table: String,
  val packageName: String,
  val limit: Int,
  val offset: Int,
)
