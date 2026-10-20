package dev.jasonpearson.automobile.desktop.core.daemon

import java.net.http.HttpRequest
import java.net.http.HttpResponse
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

fun interface HttpRequestSender {
  fun send(request: HttpRequest): HttpResponse<String>
}

class McpHttpClient private constructor(private val transport: McpHttpTransport) :
  AutoMobileClient,
  AutoMobileDeviceOperations by McpHttpDeviceOperations(transport),
  AutoMobileTestOperations by McpHttpTestOperations(transport),
  AutoMobileStorageOperations by McpHttpStorageOperations(transport),
  AutoMobileFeatureOperations by McpHttpFeatureOperations(transport),
  AutoMobileInputOperations by McpHttpInputOperations(transport) {
  constructor(options: McpHttpClientOptions) : this(McpHttpTransport(options))

  override val transportName = "MCP HTTP"
  override val connectionDescription = transport.options.endpoint
  private val resources = McpHttpResources(transport)

  override fun ping() = resources.ping()

  override fun listResources() = resources.listResources()

  override fun listResourceTemplates() = resources.listResourceTemplates()

  override fun listTools() = resources.listTools()

  override fun readResource(uri: String) = resources.readResource(uri)

  override fun callTool(name: String, arguments: JsonObject) = transport.callTool(name, arguments)

  companion object {
    internal const val MCP_SESSION_KEY_HEADER = "x-auto-mobile-mcp-session-id"

    internal fun isRetryableError(e: Exception): Boolean = McpHttpTransport.isRetryableError(e)
  }
}

internal fun JsonRpcResponse.resultFor(method: String): JsonElement =
  result
    ?: throw McpConnectionException(
      "JSON-RPC $method response contained no result; check the MCP server response.",
    )
