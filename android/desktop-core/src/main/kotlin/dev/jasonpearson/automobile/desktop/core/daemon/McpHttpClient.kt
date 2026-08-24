package dev.jasonpearson.automobile.desktop.core.daemon

import java.net.ConnectException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

class McpHttpClient(
  private val endpoint: String,
  private val json: Json = DaemonJson,
  private val retryPolicy: RetryPolicy = RetryPolicy(),
  private val statusRequestTimeoutMs: Long = McpDaemonClient.STATUS_REQUEST_TIMEOUT_MS,
) : AutoMobileClient {
  override val transportName: String = "MCP HTTP"
  override val connectionDescription: String = endpoint
  private val testRecordingClient = TestRecordingSocketClient()

  private val httpClient = HttpClient.newBuilder().build()
  private var sessionId: String? = null
  private var protocolVersion: String? = null
  private var initialized = false

  override fun ping() {
    ensureInitialized()
  }

  override fun listResources(): List<McpResource> {
    ensureInitialized()
    val response = sendRequest("resources/list")
    val result = json.decodeFromJsonElement(serializer<ListResourcesResult>(), response.result!!)
    return result.resources
  }

  override fun listResourceTemplates(): List<McpResourceTemplate> {
    ensureInitialized()
    val response = sendRequest("resources/list-templates")
    val result =
      json.decodeFromJsonElement(serializer<ListResourceTemplatesResult>(), response.result!!)
    return result.resourceTemplates
  }

  override fun listTools(): List<McpTool> {
    ensureInitialized()
    val response = sendRequest("tools/list")
    val result = json.decodeFromJsonElement(serializer<ListToolsResult>(), response.result!!)
    return result.tools
  }

  override fun readResource(uri: String): List<McpResourceContent> {
    ensureInitialized()
    val response =
      sendRequest(
        "resources/read",
        buildJsonObject { put("uri", JsonPrimitive(uri)) },
      )
    val result = json.decodeFromJsonElement(serializer<ReadResourceResult>(), response.result!!)
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
  ): PerformanceAuditHistoryResult {
    val uri = buildPerformanceResultsUri(startTime, endTime, limit, offset)
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
    return try {
      decodeToolResponse(json, response, serializer<ObserveResult>())
    } catch (e: Exception) {
      if (e is CancellationException) throw e
      ObserveResult()
    }
  }

  override fun killDevice(name: String, deviceId: String, platform: String): KillDeviceResult {
    val response =
      callTool(
        "killDevice",
        buildJsonObject {
          put(
            "device",
            buildJsonObject {
              put("name", JsonPrimitive(name))
              put("deviceId", JsonPrimitive(deviceId))
              put("platform", JsonPrimitive(platform))
            },
          )
        },
      )
    return try {
      decodeToolResponse(json, response, serializer<KillDeviceResult>())
    } catch (e: Exception) {
      if (e is CancellationException) throw e
      KillDeviceResult(success = false, message = e.message ?: "Failed to kill device")
    }
  }

  override fun getDaemonStatus():
    dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse {
    val response =
      callToolWithTimeout(
        "getDaemonStatus",
        JsonObject(emptyMap()),
        statusRequestTimeoutMs,
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
    timeoutMs: Long? = null,
  ): JsonElement {
    ensureInitialized(timeoutMs)
    val response =
      sendRequest(
        "tools/call",
        buildJsonObject {
          put("name", JsonPrimitive(name))
          put("arguments", arguments)
        },
        timeoutMs = timeoutMs,
      )
    return response.result ?: JsonObject(emptyMap())
  }

  private fun ensureInitialized(timeoutMs: Long? = null) {
    if (initialized) {
      return
    }

    val response =
      sendRequest(
        "initialize",
        buildInitializeParams(),
        includeSession = false,
        timeoutMs = timeoutMs,
      )

    val result =
      response.result?.jsonObject
        ?: throw McpConnectionException("Initialize response missing result")
    protocolVersion = negotiateProtocolVersion(result)
    initialized = true

    sendNotification("notifications/initialized", timeoutMs = timeoutMs)
  }

  private fun sendNotification(
    method: String,
    params: JsonElement? = null,
    timeoutMs: Long? = null,
  ) {
    val request =
      JsonRpcRequest(
        id = null,
        method = method,
        params = params,
      )
    sendRequest(request, includeSession = true, expectResponse = false, timeoutMs = timeoutMs)
  }

  private fun sendRequest(
    method: String,
    params: JsonElement? = null,
    includeSession: Boolean = true,
    timeoutMs: Long? = null,
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
      timeoutMs = timeoutMs,
    )
  }

  private fun sendRequest(
    request: JsonRpcRequest,
    includeSession: Boolean,
    expectResponse: Boolean,
    timeoutMs: Long? = null,
  ): JsonRpcResponse {
    val requestBody = json.encodeToString(serializer<JsonRpcRequest>(), request)
    val builder =
      HttpRequest.newBuilder(URI.create(endpoint)).header("Content-Type", "application/json")

    if (includeSession && sessionId != null) {
      builder.header("mcp-session-id", sessionId!!)
    }
    if (protocolVersion != null) {
      builder.header("mcp-protocol-version", protocolVersion!!)
    }
    timeoutMs?.let { builder.timeout(Duration.ofMillis(it)) }

    val httpRequest = builder.POST(HttpRequest.BodyPublishers.ofString(requestBody)).build()
    val response =
      if (timeoutMs == null) {
        retryWithBackoffBlocking(retryPolicy, isRetryable = ::isRetryableError) {
          httpClient.send(httpRequest, HttpResponse.BodyHandlers.ofString())
        }
      } else {
        // A health probe has one end-to-end hang ceiling. Retrying its individually timed requests
        // would turn a 5s deadline into an unbounded series of 5s waits.
        httpClient.send(httpRequest, HttpResponse.BodyHandlers.ofString())
      }

    response.headers().firstValue("mcp-session-id").ifPresent { header ->
      if (header.isNotBlank()) {
        sessionId = header
      }
    }

    val statusCode = response.statusCode()
    if (statusCode >= 500) {
      throw McpConnectionException("MCP HTTP server error $statusCode")
    }

    if (!expectResponse) {
      return JsonRpcResponse(jsonrpc = "2.0")
    }

    val body = response.body().trim()
    if (body.isEmpty()) {
      throw McpConnectionException("MCP HTTP response was empty")
    }

    val rpcResponse = json.decodeFromString(serializer<JsonRpcResponse>(), body)
    if (rpcResponse.error != null) {
      throw McpConnectionException(
        "MCP HTTP error ${rpcResponse.error.code}: ${rpcResponse.error.message}"
      )
    }
    if (rpcResponse.result == null) {
      throw McpConnectionException("MCP HTTP response missing result")
    }
    return rpcResponse
  }

  companion object {
    internal fun isRetryableError(e: Exception): Boolean =
      e is ConnectException ||
        e is java.net.http.HttpTimeoutException ||
        (e is McpConnectionException && e.message?.contains("server error") == true)
  }
}
