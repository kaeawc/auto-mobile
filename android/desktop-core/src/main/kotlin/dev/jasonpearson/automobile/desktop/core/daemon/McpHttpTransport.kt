package dev.jasonpearson.automobile.desktop.core.daemon

import java.net.ConnectException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.UUID
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

internal class McpHttpTransport(val options: McpHttpClientOptions) {
  val json = options.json
  private val endpoint = options.endpoint
  private val retryPolicy = options.retryPolicy
  private val requestSender = options.requestSender
  private val mcpSessionKey = options.mcpSessionKey
  private val httpClient = HttpClient.newBuilder().build()
  private val decoder = McpHttpResponseDecoder(json)
  @Volatile private var sessionId: String? = null
  @Volatile private var protocolVersion: String? = null
  @Volatile private var initialized = false

  fun callTool(name: String, arguments: JsonObject): JsonElement {
    return callToolWithTimeout(name, arguments)
  }

  fun callToolWithTimeout(
    name: String,
    arguments: JsonObject,
    deadline: StatusRequestDeadline? = null,
  ): JsonElement {
    ensureInitialized(deadline)
    val response =
      sendRequest(
        "tools/call",
        buildJsonObject {
          put("name", JsonPrimitive(name))
          put("arguments", arguments)
        },
        deadline = deadline,
      )
    return response.result ?: JsonObject(emptyMap())
  }

  fun ensureInitialized(
    deadline: StatusRequestDeadline? = null,
    recoverLostSession: Boolean = true,
  ) {
    if (initialized) {
      return
    }

    val response =
      sendRequest(
        "initialize",
        buildInitializeParams(),
        includeSession = false,
        deadline = deadline,
      )

    val result =
      response.result?.jsonObject
        ?: throw McpConnectionException("Initialize response missing result")
    protocolVersion = negotiateProtocolVersion(result)
    initialized = true

    sendNotification(
      "notifications/initialized",
      deadline = deadline,
      recoverLostSession = recoverLostSession,
    )
  }

  private fun sendNotification(
    method: String,
    params: JsonElement? = null,
    deadline: StatusRequestDeadline? = null,
    recoverLostSession: Boolean = true,
  ) {
    val request =
      JsonRpcRequest(
        id = null,
        method = method,
        params = params,
      )
    sendRequest(
      request,
      includeSession = true,
      expectResponse = false,
      deadline = deadline,
      recoverLostSession = recoverLostSession,
    )
  }

  fun sendRequest(
    method: String,
    params: JsonElement? = null,
    includeSession: Boolean = true,
    deadline: StatusRequestDeadline? = null,
  ): JsonRpcResponse {
    val requestId = JsonPrimitive(UUID.randomUUID().toString())
    val request =
      JsonRpcRequest(
        id = requestId,
        method = method,
        params = params,
      )
    return sendRequest(
      request,
      includeSession = includeSession,
      expectResponse = true,
      deadline = deadline,
    )
  }

  fun sendRequest(
    request: JsonRpcRequest,
    includeSession: Boolean,
    expectResponse: Boolean,
    deadline: StatusRequestDeadline? = null,
    recoverLostSession: Boolean = true,
  ): JsonRpcResponse {
    val sentSessionId = if (includeSession) sessionId else null
    var response = exchange(request, includeSession, deadline)
    if (recoverLostSession && sentSessionId != null && decoder.isSessionLost(response)) {
      response = replayAfterSessionLoss(request, sentSessionId, deadline)
    }

    val statusCode = response.statusCode()
    if (statusCode >= 500) {
      throw McpConnectionException("MCP HTTP server error $statusCode")
    }

    if (!expectResponse) {
      return JsonRpcResponse(jsonrpc = "2.0")
    }

    val body = response.body().trim()
    if (statusCode !in 200..299) {
      throw decoder.httpFailure(statusCode, body)
    }
    if (body.isEmpty()) {
      throw McpConnectionException("MCP HTTP response was empty")
    }

    val rpcResponse =
      if (decoder.isEventStream(response)) {
        decoder.responseFromEventStream(request, body)
      } else {
        decoder.decodeJsonRpcResponse(body)
      }
    if (rpcResponse.error != null) {
      throw McpConnectionException(
        "MCP HTTP error ${rpcResponse.error.code}: ${rpcResponse.error.message}",
      )
    }
    rpcResponse.resultFor(request.method)
    return rpcResponse
  }

  /** Sends one POST and records the session id the server hands back. */
  private fun exchange(
    request: JsonRpcRequest,
    includeSession: Boolean,
    deadline: StatusRequestDeadline?,
  ): HttpResponse<String> {
    val requestBody = json.encodeToString(serializer<JsonRpcRequest>(), request)
    // The MCP streamable-HTTP transport answers 406 unless Accept lists both forms.
    val builder =
      HttpRequest.newBuilder(URI.create(endpoint))
        .header("Content-Type", "application/json")
        .header("Accept", MCP_ACCEPT_HEADER)
        .header(MCP_SESSION_KEY_HEADER, mcpSessionKey)

    if (includeSession) {
      sessionId?.let { builder.header(SESSION_HEADER, it) }
    }
    protocolVersion?.let { builder.header("mcp-protocol-version", it) }
    val timeoutMs = deadline?.remainingTimeoutMs()
    timeoutMs?.let { builder.timeout(Duration.ofMillis(it)) }

    val httpRequest = builder.POST(HttpRequest.BodyPublishers.ofString(requestBody)).build()
    val response =
      if (timeoutMs == null) {
        retryWithBackoffBlocking(retryPolicy, isRetryable = ::isRetryableError) {
          sendHttpRequest(httpRequest)
        }
      } else {
        // A health probe has one end-to-end hang ceiling. Retrying its individually timed requests
        // would turn a 5s deadline into an unbounded series of 5s waits.
        sendHttpRequest(httpRequest)
      }

    response.headers().firstValue(SESSION_HEADER).ifPresent { header ->
      if (header.isNotBlank()) {
        sessionId = header
      }
    }
    return response
  }

  /**
   * The daemon answers 404 before it dispatches anything when the session id is unknown (for
   * example after a daemon restart), so the rejected request never ran and is safe to replay once
   * on a fresh session. Re-initialising is attempted exactly once per request: a daemon that keeps
   * answering 404 fails with a clear error instead of looping.
   */
  private fun replayAfterSessionLoss(
    request: JsonRpcRequest,
    lostSessionId: String,
    deadline: StatusRequestDeadline?,
  ): HttpResponse<String> {
    // Only drop the session this request used: another thread may already have replaced it.
    if (sessionId == lostSessionId) {
      resetSession()
    }
    ensureInitialized(deadline, recoverLostSession = false)
    val replayed = exchange(request, includeSession = true, deadline = deadline)
    if (decoder.isSessionLost(replayed)) {
      resetSession()
      throw McpConnectionException(
        "MCP session lost: $endpoint answered 404 Session not found again after re-initializing; " +
          "the daemon is not keeping the new session",
      )
    }
    return replayed
  }

  private fun resetSession() {
    sessionId = null
    protocolVersion = null
    initialized = false
  }

  /** True for the daemon's `{"error":"Session not found"}` and the SDK's JSON-RPC -32001 form. */
  private fun sendHttpRequest(request: HttpRequest): HttpResponse<String> =
    requestSender?.send(request) ?: httpClient.send(request, HttpResponse.BodyHandlers.ofString())

  companion object {
    /** Must match `MCP_SESSION_KEY_HEADER` in src/daemon/mcpSessionKey.ts. */
    internal const val MCP_SESSION_KEY_HEADER = "x-auto-mobile-mcp-session-id"
    private const val SESSION_HEADER = "mcp-session-id"
    private const val MCP_ACCEPT_HEADER = "application/json, text/event-stream"
    private const val EVENT_STREAM = "text/event-stream"
    private const val SESSION_NOT_FOUND = "Session not found"
    private const val MAX_ERROR_BODY_CHARS = 200

    internal fun isRetryableError(e: Exception): Boolean =
      e is ConnectException ||
        e is java.net.http.HttpTimeoutException ||
        (e is McpConnectionException && e.message?.contains("server error") == true)
  }
}
