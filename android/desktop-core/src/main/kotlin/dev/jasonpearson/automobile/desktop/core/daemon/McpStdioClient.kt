package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.TimeUnit
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

class McpStdioClient(
  private val command: String,
  private val json: Json = DaemonJson,
  private val statusRequestTimeoutMs: Long = McpDaemonClient.STATUS_REQUEST_TIMEOUT_MS,
  private val statusDeadlineFactory: (Long) -> StatusRequestDeadline = {
    StatusRequestDeadline(it)
  },
  private val processStarter: (List<String>) -> Process = { commandParts ->
    ProcessBuilder(commandParts).redirectError(ProcessBuilder.Redirect.INHERIT).start()
  },
  private val responseReader: StdioResponseReader = StdioResponseReader { read, timeoutMs ->
    if (timeoutMs == null) {
      read.call()
    } else {
      requestReader.submit(read).get(timeoutMs, TimeUnit.MILLISECONDS)
    }
  },
) : AutoMobileClient {
  override val transportName: String = "MCP STDIO"
  override val connectionDescription: String = command
  private val testRecordingClient = TestRecordingSocketClient()

  private val ioLock = Any()
  private var process: Process? = null
  private var reader: BufferedReader? = null
  private var writer: BufferedWriter? = null
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
      dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse()
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
      UpdateServiceResult(success = false, message = e.message ?: "Failed to update service")
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
          put(
            "value",
            if (value != null) JsonPrimitive(value) else kotlinx.serialization.json.JsonNull,
          )
          put("type", JsonPrimitive(type))
        },
      )
    return try {
      decodeToolResponse(json, response, serializer<SetKeyValueResult>())
    } catch (e: Exception) {
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
      ClearKeyValueResult(success = false, message = e.message ?: "Failed to clear key value file")
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

  override fun close() {
    synchronized(ioLock) {
      try {
        writer?.flush()
      } catch (_: Exception) {}
      process?.destroy()
      process = null
      reader = null
      writer = null
    }
  }

  private fun ensureInitialized(deadline: StatusRequestDeadline? = null) {
    synchronized(ioLock) {
      deadline?.remainingTimeoutMs()
      if (initialized) {
        return
      }
      ensureProcessStarted()
    }

    val response =
      sendRequest(
        "initialize",
        buildInitializeParams(),
        deadline = deadline,
      )
    val result =
      response.result?.jsonObject
        ?: throw McpConnectionException("Initialize response missing result")
    negotiateProtocolVersion(result)
    synchronized(ioLock) {
      initialized = true
    }
    sendNotification("notifications/initialized", deadline = deadline)
  }

  private fun sendNotification(
    method: String,
    params: JsonElement? = null,
    deadline: StatusRequestDeadline? = null,
  ) {
    val request =
      JsonRpcRequest(
        id = null,
        method = method,
        params = params,
      )
    sendRequest(request, expectResponse = false, deadline = deadline)
  }

  private fun sendRequest(
    method: String,
    params: JsonElement? = null,
    deadline: StatusRequestDeadline? = null,
  ): JsonRpcResponse {
    val requestId = JsonPrimitive(UUID.randomUUID().toString())
    val request =
      JsonRpcRequest(
        id = requestId,
        method = method,
        params = params,
      )
    return sendRequest(request, expectResponse = true, deadline = deadline)
  }

  private fun sendRequest(
    request: JsonRpcRequest,
    expectResponse: Boolean,
    deadline: StatusRequestDeadline? = null,
  ): JsonRpcResponse {
    synchronized(ioLock) {
      val timeoutMs = deadline?.remainingTimeoutMs()
      ensureProcessStarted()
      val currentProcess = process ?: throw McpConnectionException("MCP stdio process unavailable")
      val currentWriter = writer ?: throw McpConnectionException("MCP stdio writer unavailable")
      val currentReader = reader ?: throw McpConnectionException("MCP stdio reader unavailable")

      val requestBody = json.encodeToString(serializer<JsonRpcRequest>(), request)
      currentWriter.write(requestBody)
      currentWriter.newLine()
      currentWriter.flush()

      if (!expectResponse) {
        return JsonRpcResponse(jsonrpc = "2.0")
      }

      try {
        val expectedId = request.id?.jsonPrimitive?.content
        val read = Callable { readResponse(currentReader, expectedId) }
        return responseReader.read(read, timeoutMs)
      } catch (_: java.util.concurrent.TimeoutException) {
        // BufferedReader.readLine() cannot be reliably interrupted. Its worker stays isolated on
        // the old stream while this caller releases ioLock; later requests start a fresh process.
        if (process === currentProcess) {
          process = null
          reader = null
          writer = null
          initialized = false
        }
        terminateProcessTree(currentProcess)
        throw McpConnectionException(
          "MCP stdio request '${request.method}' timed out after ${timeoutMs}ms"
        )
      } catch (e: java.util.concurrent.ExecutionException) {
        throw (e.cause as? Exception ?: e)
      }
    }
  }

  private fun readResponse(currentReader: BufferedReader, expectedId: String?): JsonRpcResponse {
    while (true) {
      val line = currentReader.readLine() ?: throw McpConnectionException("MCP stdio closed")
      if (line.isBlank()) continue
      val response = json.decodeFromString(serializer<JsonRpcResponse>(), line)
      val responseId = response.id?.jsonPrimitive?.content
      if (expectedId != null && responseId != expectedId) continue
      if (response.error != null) {
        throw McpConnectionException(
          "MCP stdio error ${response.error.code}: ${response.error.message}"
        )
      }
      if (response.result == null) throw McpConnectionException("MCP stdio response missing result")
      return response
    }
  }

  private fun terminateProcessTree(currentProcess: Process) {
    try {
      currentProcess.toHandle().descendants().use { descendants ->
        descendants.forEach { descendant -> descendant.destroyForcibly() }
      }
    } catch (_: UnsupportedOperationException) {
      // Test doubles and constrained runtimes may not expose process handles.
    }
    currentProcess.destroyForcibly()
  }

  private fun ensureProcessStarted() {
    if (process != null) {
      return
    }

    val commandParts = parseCommand(command)
    if (commandParts.isEmpty()) {
      throw McpConnectionException("MCP stdio command is empty")
    }

    val newProcess = processStarter(commandParts)
    process = newProcess
    reader = BufferedReader(InputStreamReader(newProcess.inputStream))
    writer = BufferedWriter(OutputStreamWriter(newProcess.outputStream))
  }

  private fun parseCommand(command: String): List<String> {
    val parts = mutableListOf<String>()
    val current = StringBuilder()
    var inSingle = false
    var inDouble = false
    var escapeNext = false

    fun flushCurrent() {
      if (current.isNotEmpty()) {
        parts.add(current.toString())
        current.clear()
      }
    }

    for (char in command) {
      if (escapeNext) {
        current.append(char)
        escapeNext = false
        continue
      }

      when (char) {
        '\\' -> {
          if (inDouble) {
            escapeNext = true
          } else {
            current.append(char)
          }
        }
        '\'' -> {
          if (!inDouble) {
            inSingle = !inSingle
          } else {
            current.append(char)
          }
        }
        '"' -> {
          if (!inSingle) {
            inDouble = !inDouble
          } else {
            current.append(char)
          }
        }
        ' ',
        '\t',
        '\n' -> {
          if (inSingle || inDouble) {
            current.append(char)
          } else {
            flushCurrent()
          }
        }
        else -> current.append(char)
      }
    }

    flushCurrent()
    return parts
  }

  private companion object {
    private val requestReader =
      java.util.concurrent.Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "mcp-stdio-response-reader").apply { isDaemon = true }
      }
  }
}

fun interface StdioResponseReader {
  fun read(read: Callable<JsonRpcResponse>, timeoutMs: Long?): JsonRpcResponse
}
