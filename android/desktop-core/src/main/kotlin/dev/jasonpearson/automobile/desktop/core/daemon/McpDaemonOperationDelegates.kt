package dev.jasonpearson.automobile.desktop.core.daemon

internal class McpDaemonOperationDelegates {
  lateinit var owner: McpDaemonClient
  val device = McpDaemonDeviceOperations { owner }
  val test = McpDaemonTestOperations { owner }
  val feature = McpDaemonFeatureOperations { owner }
  val storage = McpDaemonStorageOperations { owner }
  val input = McpDaemonInputOperations { owner }
}
