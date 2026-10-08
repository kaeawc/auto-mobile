package dev.jasonpearson.automobile.desktop.core.daemon

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
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

  /** Params the client sent on `initialize`, for asserting the handshake. */
  @Volatile
  var initializeParams: JsonObject? = null
    private set

  /**
   * `protocolVersion` returned from `initialize`. Set to an unsupported revision, or to null to
   * omit the field entirely, to exercise negotiation failures.
   */
  @Volatile var negotiatedProtocolVersion: String? = LATEST_MCP_PROTOCOL_VERSION

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

  /**
   * When true (the default, like the real daemon, whose transport is built without
   * `enableJsonResponse`) replies to requests are `text/event-stream` bodies with a `:keepalive`
   * comment ahead of the `event: message` frame. When false they are plain JSON bodies.
   */
  @Volatile var answerWithEventStream: Boolean = true

  /**
   * Splits an event-stream reply into separately flushed writes (chunked transfer), so a test can
   * tear a multi-byte character across network reads. Null writes the body in one piece.
   */
  @Volatile var eventStreamChunker: ((ByteArray) -> List<ByteArray>)? = null

  /** Every `Accept` header received on a POST, in order (`null` when the header was missing). */
  val acceptHeaders = CopyOnWriteArrayList<String?>()

  private val sessions = ConcurrentHashMap.newKeySet<String>()
  private val sessionCounter = AtomicInteger()

  /** Forgets every session, like a daemon restart: previously issued ids now answer 404. */
  fun forgetSessions() {
    sessions.clear()
  }

  fun start(): Int {
    val httpServer = HttpServer.create(InetSocketAddress(port), 0)
    httpServer.createContext("/") { exchange ->
      try {
        handleExchange(exchange)
      } catch (e: Exception) {
        reply(exchange, 200, jsonRpcError(-32603, e.message ?: "Internal error"))
      }
    }
    httpServer.start()
    server = httpServer
    return httpServer.address.port
  }

  private fun handleExchange(exchange: HttpExchange) {
    val accept = exchange.requestHeaders.getFirst("Accept")
    acceptHeaders.add(accept)
    // The MCP SDK's streamable transport answers 406 unless Accept lists both response forms.
    if (accept == null || !accept.contains(JSON) || !accept.contains(EVENT_STREAM)) {
      reply(exchange, 406, jsonRpcError(-32000, "Not Acceptable: Client must accept both"))
      return
    }
    val body = exchange.requestBody.bufferedReader().readText()
    val request = json.decodeFromString(JsonRpcRequest.serializer(), body)
    if (request.method == "initialize") {
      val newSession = "test-session-${sessionCounter.incrementAndGet()}"
      sessions.add(newSession)
      respond(exchange, request, newSession)
      return
    }
    // Like the daemon, an unknown session id is rejected before anything is dispatched.
    val sessionHeader = exchange.requestHeaders.getFirst("mcp-session-id")
    when {
      sessionHeader == null ->
        reply(exchange, 400, jsonRpcError(-32000, "Bad Request: Mcp-Session-Id required"))
      sessionHeader !in sessions -> reply(exchange, 404, """{"error":"Session not found"}""")
      else -> respond(exchange, request, sessionHeader)
    }
  }

  private fun respond(exchange: HttpExchange, request: JsonRpcRequest, sessionId: String) {
    val response = handleRequest(request)
    exchange.responseHeaders.add("mcp-session-id", sessionId)
    if (request.id == null) {
      // Notifications are acknowledged with 202 and no body.
      exchange.sendResponseHeaders(202, -1)
      exchange.responseBody.close()
      return
    }
    val responseBody = json.encodeToString(JsonRpcResponse.serializer(), response)
    if (!answerWithEventStream) {
      reply(exchange, 200, responseBody)
      return
    }
    val stream = ":keepalive\n\nevent: message\ndata: $responseBody\n\n"
    val chunker = eventStreamChunker
    if (chunker == null) {
      reply(exchange, 200, stream, contentType = EVENT_STREAM)
      return
    }
    exchange.responseHeaders.add("Content-Type", EVENT_STREAM)
    exchange.sendResponseHeaders(200, 0)
    exchange.responseBody.use { out ->
      for (chunk in chunker(stream.toByteArray())) {
        out.write(chunk)
        out.flush()
      }
    }
  }

  private fun reply(
    exchange: HttpExchange,
    status: Int,
    body: String,
    contentType: String = JSON,
  ) {
    val bytes = body.toByteArray()
    exchange.responseHeaders.add("Content-Type", contentType)
    exchange.sendResponseHeaders(status, bytes.size.toLong())
    exchange.responseBody.use { it.write(bytes) }
  }

  private fun jsonRpcError(code: Int, message: String): String =
    json.encodeToString(
      JsonRpcResponse.serializer(),
      JsonRpcResponse(jsonrpc = "2.0", error = JsonRpcError(code = code, message = message)),
    )

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
    initializeParams = request.params?.jsonObject
    return JsonRpcResponse(
      jsonrpc = "2.0",
      id = request.id,
      result =
        buildJsonObject {
          negotiatedProtocolVersion?.let { put("protocolVersion", it) }
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

  private companion object {
    const val JSON = "application/json"
    const val EVENT_STREAM = "text/event-stream"
  }
}
