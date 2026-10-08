package dev.jasonpearson.automobile.desktop.core.daemon

import java.net.ConnectException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

fun interface HttpRequestSender {
  fun send(request: HttpRequest): HttpResponse<String>
}

class McpHttpClient(
  private val endpoint: String,
  private val json: Json = DaemonJson,
  private val retryPolicy: RetryPolicy = RetryPolicy(),
  private val statusRequestTimeoutMs: Long = McpDaemonClient.STATUS_REQUEST_TIMEOUT_MS,
  private val statusDeadlineFactory: (Long) -> StatusRequestDeadline = {
    StatusRequestDeadline(it)
  },
  private val requestSender: HttpRequestSender? = null,
) : AutoMobileClient {
  override val transportName: String = "MCP HTTP"
  override val connectionDescription: String = endpoint
  private val testRecordingClient = TestRecordingSocketClient()

  private val httpClient = HttpClient.newBuilder().build()
  @Volatile private var sessionId: String? = null
  @Volatile private var protocolVersion: String? = null
  @Volatile private var initialized = false

  override fun ping() {
    ensureInitialized()
  }

  override fun listResources(): List<McpResource> {
    ensureInitialized()
    val response = sendRequest("resources/list")
    val result =
      json.decodeFromJsonElement(
        serializer<ListResourcesResult>(),
        response.resultFor("resources/list"),
      )
    return result.resources
  }

  override fun listResourceTemplates(): List<McpResourceTemplate> {
    ensureInitialized()
    val response = sendRequest("resources/list-templates")
    val result =
      json.decodeFromJsonElement(
        serializer<ListResourceTemplatesResult>(),
        response.resultFor("resources/list-templates"),
      )
    return result.resourceTemplates
  }

  override fun listTools(): List<McpTool> {
    ensureInitialized()
    val response = sendRequest("tools/list")
    val result =
      json.decodeFromJsonElement(serializer<ListToolsResult>(), response.resultFor("tools/list"))
    return result.tools
  }

  override fun readResource(uri: String): List<McpResourceContent> {
    ensureInitialized()
    val response =
      sendRequest(
        "resources/read",
        buildJsonObject { put("uri", JsonPrimitive(uri)) },
      )
    val result =
      json.decodeFromJsonElement(
        serializer<ReadResourceResult>(),
        response.resultFor("resources/read"),
      )
    return result.contents
  }

  override fun getNavigationGraph(platform: String): JsonElement {
    val response =
      callTool(
        "getNavigationGraph",
        buildJsonObject { put("platform", JsonPrimitive(platform)) },
      )
    return response
  }

  override fun listFeatureFlags(): List<FeatureFlagState> {
    val response = callTool("listFeatureFlags", JsonObject(emptyMap()))
    val result = decodeToolResponse(json, response, serializer<FeatureFlagListResult>())
    return result.flags
  }

  override fun setFeatureFlag(
    key: String,
    enabled: Boolean,
    config: JsonObject?,
  ): FeatureFlagState {
    val response =
      callTool(
        "setFeatureFlag",
        buildJsonObject {
          put("key", JsonPrimitive(key))
          put("enabled", JsonPrimitive(enabled))
          if (config != null) {
            put("config", config)
          }
        },
      )
    return decodeToolResponse(json, response, serializer<FeatureFlagState>())
  }

  override fun listPerformanceAuditResults(
    startTime: String?,
    endTime: String?,
    limit: Int?,
    offset: Int?,
    deviceId: String?,
  ): PerformanceAuditHistoryResult {
    val uri = buildPerformanceResultsUri(startTime, endTime, limit, offset, deviceId)
    val contents = readResource(uri)
    return decodePerformanceAuditResource(json, contents)
  }

  override fun getTestTimings(query: TestTimingQuery): TestTimingSummary {
    val contents = readResource(query.toResourceUri())
    return decodeResourceResponse(json, contents, serializer<TestTimingSummary>())
  }

  override fun getTestRuns(query: TestRunQuery): TestRunSummary {
    val contents = readResource(query.toResourceUri())
    return decodeResourceResponse(json, contents, serializer<TestRunSummary>())
  }

  override fun startTestRecording(platform: String): TestRecordingStartResult {
    return testRecordingClient.startTestRecording(platform)
  }

  override fun stopTestRecording(
    recordingId: String?,
    planName: String?,
  ): TestRecordingStopResult {
    val resolvedPlanName = planName?.ifBlank { null }
    return testRecordingClient.stopTestRecording(recordingId, resolvedPlanName)
  }

  override fun executePlan(
    planContent: String,
    platform: String,
    startStep: Int?,
    sessionUuid: String?,
  ): ExecutePlanResult {
    val response =
      callTool(
        "executePlan",
        buildJsonObject {
          put("planContent", JsonPrimitive(planContent))
          put("platform", JsonPrimitive(platform))
          if (startStep != null) {
            put("startStep", JsonPrimitive(startStep))
          }
          if (!sessionUuid.isNullOrBlank()) {
            put("sessionUuid", JsonPrimitive(sessionUuid))
          }
        },
      )
    return decodeToolResponse(json, response, serializer<ExecutePlanResult>())
  }

  override fun startDevice(name: String, platform: String, deviceId: String?): StartDeviceResult {
    val response =
      callTool(
        "startDevice",
        buildJsonObject {
          put(
            "device",
            buildJsonObject {
              put("name", JsonPrimitive(name))
              put("platform", JsonPrimitive(platform))
              if (deviceId != null) {
                put("deviceId", JsonPrimitive(deviceId))
              }
            },
          )
        },
      )
    return try {
      decodeToolResponse(json, response, serializer<StartDeviceResult>())
    } catch (e: Exception) {
      if (e is CancellationException) throw e
      StartDeviceResult(success = false, message = e.message ?: "Failed to start device")
    }
  }

  override fun setActiveDevice(deviceId: String, platform: String): SetActiveDeviceResult {
    val response =
      callTool(
        "setActiveDevice",
        buildJsonObject {
          put("deviceId", JsonPrimitive(deviceId))
          put("platform", JsonPrimitive(platform))
        },
      )
    return try {
      decodeToolResponse(json, response, serializer<SetActiveDeviceResult>())
    } catch (e: Exception) {
      if (e is CancellationException) throw e
      SetActiveDeviceResult(success = false, message = e.message ?: "Failed to set active device")
    }
  }

  override fun observe(platform: String): ObserveResult {
    val response =
      callTool(
        "observe",
        buildJsonObject {
          put("platform", JsonPrimitive(platform))
        },
      )
    return decodeObserveResponse(json, response)
  }

  override fun killDevice(
    name: String,
    deviceId: String,
    platform: String,
    force: Boolean,
  ): KillDeviceResult {
    val response = callTool("killDevice", killDeviceArguments(name, deviceId, platform, force))
    return try {
      decodeToolResponse(json, response, serializer<KillDeviceResult>())
    } catch (e: Exception) {
      if (e is CancellationException) throw e
      KillDeviceResult(success = false, message = e.message ?: "Failed to kill device")
    }
  }

  override fun getDaemonStatus():
    dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse {
    val deadline = statusDeadlineFactory(statusRequestTimeoutMs)
    val response =
      callToolWithTimeout(
        "getDaemonStatus",
        JsonObject(emptyMap()),
        deadline,
      )
    return try {
      decodeToolResponse(
        json,
        response,
        serializer<dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse>(),
      )
    } catch (e: Exception) {
      if (e is CancellationException) throw e
      dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse()
    }
  }

  override fun setKeyValue(
    deviceId: String,
    appId: String,
    fileName: String,
    key: String,
    value: String?,
    type: String,
    platform: String,
  ): SetKeyValueResult {
    val response =
      callTool(
        "setKeyValue",
        buildJsonObject {
          put("deviceId", JsonPrimitive(deviceId))
          put("platform", JsonPrimitive(platform))
          put("appId", JsonPrimitive(appId))
          put("fileName", JsonPrimitive(fileName))
          put("key", JsonPrimitive(key))
          put("value", if (value != null) JsonPrimitive(value) else JsonNull)
          put("type", JsonPrimitive(type))
        },
      )
    return try {
      decodeToolResponse(json, response, serializer<SetKeyValueResult>())
    } catch (e: Exception) {
      if (e is CancellationException) throw e
      SetKeyValueResult(success = false, message = e.message ?: "Failed to set key value")
    }
  }

  override fun removeKeyValue(
    deviceId: String,
    appId: String,
    fileName: String,
    key: String,
    platform: String,
  ): RemoveKeyValueResult {
    val response =
      callTool(
        "removeKeyValue",
        buildJsonObject {
          put("deviceId", JsonPrimitive(deviceId))
          put("platform", JsonPrimitive(platform))
          put("appId", JsonPrimitive(appId))
          put("fileName", JsonPrimitive(fileName))
          put("key", JsonPrimitive(key))
        },
      )
    return try {
      decodeToolResponse(json, response, serializer<RemoveKeyValueResult>())
    } catch (e: Exception) {
      if (e is CancellationException) throw e
      RemoveKeyValueResult(success = false, message = e.message ?: "Failed to remove key value")
    }
  }

  override fun clearKeyValueFile(
    deviceId: String,
    appId: String,
    fileName: String,
    platform: String,
  ): ClearKeyValueResult {
    val response =
      callTool(
        "clearKeyValueFile",
        buildJsonObject {
          put("deviceId", JsonPrimitive(deviceId))
          put("platform", JsonPrimitive(platform))
          put("appId", JsonPrimitive(appId))
          put("fileName", JsonPrimitive(fileName))
        },
      )
    return try {
      decodeToolResponse(json, response, serializer<ClearKeyValueResult>())
    } catch (e: Exception) {
      if (e is CancellationException) throw e
      ClearKeyValueResult(success = false, message = e.message ?: "Failed to clear key value file")
    }
  }

  override fun updateService(deviceId: String, platform: String): UpdateServiceResult {
    val response =
      callTool(
        "updateService",
        buildJsonObject {
          put("deviceId", JsonPrimitive(deviceId))
          put("platform", JsonPrimitive(platform))
        },
      )
    return try {
      decodeToolResponse(json, response, serializer<UpdateServiceResult>())
    } catch (e: Exception) {
      if (e is CancellationException) throw e
      UpdateServiceResult(success = false, message = e.message ?: "Failed to update service")
    }
  }

  override fun inputTap(
    x: Double,
    y: Double,
    platform: String,
    deviceId: String?,
    duration: Int?,
    frameContext: String?,
  ): InputActionResult = unsupportedInputAction(transportName, "input/tap")

  override fun inputSwipe(
    startX: Double,
    startY: Double,
    endX: Double,
    endY: Double,
    platform: String,
    deviceId: String?,
    durationMs: Int?,
    frameContext: String?,
  ): InputActionResult = unsupportedInputAction(transportName, "input/swipe")

  override fun inputPressButton(
    button: String,
    platform: String,
    deviceId: String?,
    frameContext: String?,
  ): InputActionResult = unsupportedInputAction(transportName, "input/pressButton")

  override fun inputTypeText(
    text: String,
    platform: String,
    deviceId: String?,
    submit: Boolean?,
    append: Boolean,
    frameContext: String?,
  ): InputActionResult = unsupportedInputAction(transportName, "input/typeText")

  override fun inputKey(
    key: String,
    platform: String,
    deviceId: String?,
    frameContext: String?,
  ): InputActionResult = unsupportedInputAction(transportName, "input/key")

  override fun callTool(name: String, arguments: JsonObject): JsonElement {
    return callToolWithTimeout(name, arguments)
  }

  private fun callToolWithTimeout(
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

  private fun ensureInitialized(
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

  private fun sendRequest(
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

  private fun sendRequest(
    request: JsonRpcRequest,
    includeSession: Boolean,
    expectResponse: Boolean,
    deadline: StatusRequestDeadline? = null,
    recoverLostSession: Boolean = true,
  ): JsonRpcResponse {
    val sentSessionId = if (includeSession) sessionId else null
    var response = exchange(request, includeSession, deadline)
    if (recoverLostSession && sentSessionId != null && isSessionLost(response)) {
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
      throw httpFailure(statusCode, body)
    }
    if (body.isEmpty()) {
      throw McpConnectionException("MCP HTTP response was empty")
    }

    val rpcResponse =
      if (isEventStream(response)) {
        responseFromEventStream(request, body)
      } else {
        decodeJsonRpcResponse(body)
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
    if (isSessionLost(replayed)) {
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
  private fun isSessionLost(response: HttpResponse<String>): Boolean {
    if (response.statusCode() != 404) {
      return false
    }
    val envelope = runCatching { json.parseToJsonElement(response.body()) }.getOrNull()
    val error = (envelope as? JsonObject)?.get("error") ?: return false
    val message =
      when (error) {
        is JsonPrimitive -> error.contentOrNull
        is JsonObject -> (error["message"] as? JsonPrimitive)?.contentOrNull
        else -> null
      }
    return message?.contains(SESSION_NOT_FOUND, ignoreCase = true) == true
  }

  private fun isEventStream(response: HttpResponse<String>): Boolean =
    response.headers().firstValue("content-type").orElse("").trimStart().startsWith(EVENT_STREAM)

  /** Picks the JSON-RPC reply to [request] out of the stream, skipping everything else. */
  private fun responseFromEventStream(request: JsonRpcRequest, body: String): JsonRpcResponse {
    for (event in SseEventParser.parse(body)) {
      if (event.data.isBlank()) {
        continue
      }
      val message = runCatching { json.parseToJsonElement(event.data) }.getOrNull() as? JsonObject
      val isReply = message != null && ("result" in message || "error" in message)
      if (message != null && isReply && message["id"] == request.id) {
        return decodeJsonRpcResponse(event.data)
      }
    }
    throw McpConnectionException(
      "MCP HTTP event stream ended without a reply to ${request.method} (id ${request.id})",
    )
  }

  private fun decodeJsonRpcResponse(body: String): JsonRpcResponse =
    try {
      json.decodeFromString(serializer<JsonRpcResponse>(), body)
    } catch (e: SerializationException) {
      throw McpConnectionException(
        "MCP HTTP response was not a JSON-RPC message: ${excerpt(body)}",
        e,
      )
    }

  /** A non-2xx reply: a JSON-RPC error envelope when there is one, otherwise status plus body. */
  private fun httpFailure(statusCode: Int, body: String): McpConnectionException {
    val error = runCatching { json.decodeFromString<JsonRpcResponse>(body) }.getOrNull()?.error
    return if (error != null) {
      McpConnectionException("MCP HTTP error ${error.code}: ${error.message} (HTTP $statusCode)")
    } else {
      McpConnectionException("MCP HTTP $statusCode: ${excerpt(body)}")
    }
  }

  private fun excerpt(body: String): String =
    if (body.length <= MAX_ERROR_BODY_CHARS) body else body.take(MAX_ERROR_BODY_CHARS) + "..."

  private fun sendHttpRequest(request: HttpRequest): HttpResponse<String> =
    requestSender?.send(request) ?: httpClient.send(request, HttpResponse.BodyHandlers.ofString())

  companion object {
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

internal fun JsonRpcResponse.resultFor(method: String): JsonElement =
  result
    ?: throw McpConnectionException(
      "JSON-RPC $method response contained no result; check the MCP server response.",
    )
