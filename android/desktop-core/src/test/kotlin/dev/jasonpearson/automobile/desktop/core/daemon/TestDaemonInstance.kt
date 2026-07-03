package dev.jasonpearson.automobile.desktop.core.daemon

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * A lightweight fake MCP HTTP server for integration testing [McpHttpClient] without a real daemon.
 *
 * Uses JDK's built-in [HttpServer] with OS-assigned port (port 0) for parallel-safe tests.
 */
class TestDaemonInstance(private val port: Int = 0) {
  private var server: HttpServer? = null
  private val json = Json { ignoreUnknownKeys = true }

  /** Tool name -> canned JSON response. */
  private val toolResponses = ConcurrentHashMap<String, JsonElement>()

  /** Resource URI -> canned resource contents. */
  private val resourceResponses = ConcurrentHashMap<String, List<McpResourceContent>>()

  /** Recorded method calls (e.g. "initialize", "tools/call:observe"). */
  val calls = CopyOnWriteArrayList<String>()

  /** Tools to advertise via tools/list. */
  private val advertisedTools = CopyOnWriteArrayList<McpTool>()

  /** Resources to advertise via resources/list. */
  private val advertisedResources = CopyOnWriteArrayList<McpResource>()

  fun setToolResponse(toolName: String, response: JsonElement) {
    toolResponses[toolName] = response
  }

  fun setResourceResponse(uri: String, contents: List<McpResourceContent>) {
    resourceResponses[uri] = contents
  }

  fun addTool(tool: McpTool) {
    advertisedTools.add(tool)
  }

  fun addResource(resource: McpResource) {
    advertisedResources.add(resource)
  }

  fun start(): Int {
    val httpServer = HttpServer.create(InetSocketAddress(port), 0)
    httpServer.createContext("/") { exchange ->
      try {
        val body = exchange.requestBody.bufferedReader().readText()
        val request = json.decodeFromString(JsonRpcRequest.serializer(), body)
        val response = handleRequest(request)
        val responseBody = json.encodeToString(JsonRpcResponse.serializer(), response)
        val responseBytes = responseBody.toByteArray()

        exchange.responseHeaders.add("Content-Type", "application/json")
        exchange.responseHeaders.add("mcp-session-id", "test-session-1")
        exchange.sendResponseHeaders(200, responseBytes.size.toLong())
        exchange.responseBody.use { it.write(responseBytes) }
      } catch (e: Exception) {
        val errorResponse =
          json.encodeToString(
            JsonRpcResponse.serializer(),
            JsonRpcResponse(
              jsonrpc = "2.0",
              error = JsonRpcError(code = -32603, message = e.message ?: "Internal error"),
            ),
          )
        val errorBytes = errorResponse.toByteArray()
        exchange.responseHeaders.add("Content-Type", "application/json")
        exchange.sendResponseHeaders(200, errorBytes.size.toLong())
        exchange.responseBody.use { it.write(errorBytes) }
      }
    }
    httpServer.start()
    server = httpServer
    return httpServer.address.port
  }

  fun stop() {
    server?.stop(0)
    server = null
  }

  private fun handleRequest(request: JsonRpcRequest): JsonRpcResponse {
    val method = request.method
    calls.add(
      when {
        method == "tools/call" -> {
          val toolName =
            request.params?.jsonObject?.get("name")?.jsonPrimitive?.content ?: "unknown"
          "tools/call:$toolName"
        }
        else -> method
      }
    )

    return when (method) {
      "initialize" -> handleInitialize(request)
      "notifications/initialized" -> JsonRpcResponse(jsonrpc = "2.0", id = request.id)
      "tools/list" -> handleToolsList(request)
      "tools/call" -> handleToolsCall(request)
      "resources/list" -> handleResourcesList(request)
      "resources/read" -> handleResourcesRead(request)
      else ->
        JsonRpcResponse(
          jsonrpc = "2.0",
          id = request.id,
          error = JsonRpcError(code = -32601, message = "Method not found: $method"),
        )
    }
  }

  private fun handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
    return JsonRpcResponse(
      jsonrpc = "2.0",
      id = request.id,
      result =
        buildJsonObject {
          put("protocolVersion", LATEST_MCP_PROTOCOL_VERSION)
          put("capabilities", JsonObject(emptyMap()))
          put(
            "serverInfo",
            buildJsonObject {
              put("name", "test-daemon")
              put("version", "0.0.1")
            },
          )
        },
    )
  }

  private fun handleToolsList(request: JsonRpcRequest): JsonRpcResponse {
    val toolsJson = advertisedTools.map { tool ->
      buildJsonObject {
        put("name", tool.name)
        if (tool.description != null) put("description", tool.description)
        if (tool.inputSchema != null) put("inputSchema", tool.inputSchema)
      }
    }
    return JsonRpcResponse(
      jsonrpc = "2.0",
      id = request.id,
      result =
        buildJsonObject {
          put(
            "tools",
            JsonArray(toolsJson),
          )
        },
    )
  }

  private fun handleToolsCall(request: JsonRpcRequest): JsonRpcResponse {
    val params = request.params?.jsonObject ?: JsonObject(emptyMap())
    val toolName = params["name"]?.jsonPrimitive?.content ?: "unknown"
    val response =
      toolResponses[toolName]
        ?: return JsonRpcResponse(
          jsonrpc = "2.0",
          id = request.id,
          error = JsonRpcError(code = -32602, message = "No response configured for: $toolName"),
        )
    return JsonRpcResponse(jsonrpc = "2.0", id = request.id, result = response)
  }

  private fun handleResourcesList(request: JsonRpcRequest): JsonRpcResponse {
    val resourcesJson = advertisedResources.map { resource ->
      buildJsonObject {
        put("uri", resource.uri)
        put("name", resource.name)
        if (resource.description != null) put("description", resource.description)
        if (resource.mimeType != null) put("mimeType", resource.mimeType)
      }
    }
    return JsonRpcResponse(
      jsonrpc = "2.0",
      id = request.id,
      result =
        buildJsonObject {
          put("resources", JsonArray(resourcesJson))
        },
    )
  }

  private fun handleResourcesRead(request: JsonRpcRequest): JsonRpcResponse {
    val params = request.params?.jsonObject ?: JsonObject(emptyMap())
    val uri = params["uri"]?.jsonPrimitive?.content ?: ""
    val contents =
      resourceResponses[uri]
        ?: return JsonRpcResponse(
          jsonrpc = "2.0",
          id = request.id,
          error = JsonRpcError(code = -32602, message = "No resource configured for: $uri"),
        )
    val contentsJson = contents.map { content ->
      buildJsonObject {
        put("uri", content.uri)
        if (content.mimeType != null) put("mimeType", content.mimeType)
        if (content.text != null) put("text", content.text)
      }
    }
    return JsonRpcResponse(
      jsonrpc = "2.0",
      id = request.id,
      result =
        buildJsonObject {
          put("contents", JsonArray(contentsJson))
        },
    )
  }
}
