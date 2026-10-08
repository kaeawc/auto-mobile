package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
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
  // The awaited read is an interruptible wait on the response pump's future and enforces the
  // deadline itself, so the default runs it on the caller's thread.
  private val responseReader: StdioResponseReader = StdioResponseReader { read, _ -> read.call() },
  restartPolicy: StdioRestartPolicy = StdioRestartPolicy(),
  private val nowNanos: () -> Long = System::nanoTime,
) : AutoMobileClient {
  override val transportName: String = "MCP STDIO"
  override val connectionDescription: String = command
  private val testRecordingClient = TestRecordingSocketClient()

  private val ioLock = Any()
  private var process: Process? = null
  private var processStartedAtNanos = 0L
  private var writer: BufferedWriter? = null
  private var pump: StdioResponsePump? = null
  private var initialized = false

  /**
   * The start-and-`initialize` handshake in progress, if any. Callers that arrive while it runs
   * wait on it instead of starting a second child or sending a second `initialize`.
   */
  private var initialization: CompletableFuture<Unit>? = null
  private val restartGuard = StdioRestartGuard(restartPolicy, nowNanos)

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
      writer = null
      pump = null
      initialized = false
      // A handshake still running on another thread fails when its pipe closes; a caller arriving
      // after close() must start afresh rather than join it.
      initialization = null
    }
  }

  /**
   * Makes sure a started, initialized child is available. A child that has exited is replaced here,
   * on the next request after the exit: the new child is started and `initialize`d exactly once
   * however many callers arrive together (one leader, the rest wait on its handshake).
   */
  private fun ensureInitialized(deadline: StatusRequestDeadline? = null) {
    val claim = claimInitialization(deadline) ?: return
    if (claim.leader) {
      initializeAsLeader(claim.flight, deadline)
    } else {
      awaitLeader(claim.flight, deadline)
    }
  }

  private class InitializationClaim(val flight: CompletableFuture<Unit>, val leader: Boolean)

  /** Null when a live, initialized child is already available. */
  private fun claimInitialization(deadline: StatusRequestDeadline?): InitializationClaim? =
    synchronized(ioLock) {
      deadline?.remainingTimeoutMs()
      reapIfExited()
      val inProgress = initialization
      when {
        inProgress != null -> InitializationClaim(inProgress, leader = false)
        initialized -> null
        else -> {
          assertRestartAllowed()
          startProcess()
          val flight = CompletableFuture<Unit>()
          initialization = flight
          InitializationClaim(flight, leader = true)
        }
      }
    }

  private fun initializeAsLeader(
    flight: CompletableFuture<Unit>,
    deadline: StatusRequestDeadline?,
  ) {
    try {
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
        if (process == null) {
          throw serverNotRunning("initialize")
        }
        initialized = true
      }
      sendNotification("notifications/initialized", deadline = deadline)
      flight.complete(Unit)
    } catch (e: Exception) {
      flight.completeExceptionally(e)
      throw e
    } finally {
      synchronized(ioLock) {
        if (initialization === flight) {
          initialization = null
        }
      }
    }
  }

  private fun awaitLeader(flight: CompletableFuture<Unit>, deadline: StatusRequestDeadline?) {
    val timeoutMs = deadline?.remainingTimeoutMs()
    try {
      if (timeoutMs == null) flight.get() else flight.get(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (e: ExecutionException) {
      val cause = e.cause
      throw McpConnectionException(cause?.message ?: "MCP stdio initialize failed", cause ?: e)
    } catch (_: TimeoutException) {
      throw McpConnectionException("MCP stdio request 'initialize' timed out after ${timeoutMs}ms")
    }
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
    val timeoutMs: Long?
    val dispatched: DispatchedRequest
    // The lock covers writing the request only. The wait for the reply happens outside it, so a
    // caller that is cancelled or past its deadline never pins the lock.
    synchronized(ioLock) {
      timeoutMs = deadline?.remainingTimeoutMs()
      dispatched = dispatch(request, expectResponse)
    }
    val pending = dispatched.pending ?: return JsonRpcResponse(jsonrpc = "2.0")
    return awaitReply(request, pending, dispatched.process, timeoutMs)
  }

  private class DispatchedRequest(val process: Process, val pending: PendingResponse?)

  /**
   * Writes [request] to the running child. Must hold [ioLock]. A request is only ever written to a
   * child that has completed `initialize` (or is being asked to), and never starts a child itself:
   * starting is [claimInitialization]'s job, so a child that vanished since the caller's
   * `ensureInitialized` produces a clear error instead of a silently uninitialized replacement.
   */
  private fun dispatch(request: JsonRpcRequest, expectResponse: Boolean): DispatchedRequest {
    if (reapIfExited()) {
      throw McpConnectionException(
        "MCP stdio server '$command' exited before '${request.method}' was sent; " +
          "the next request starts a new server",
      )
    }
    if (request.method != "initialize" && !initialized) {
      throw serverNotRunning(request.method)
    }
    val currentProcess = process ?: throw serverNotRunning(request.method)
    val currentWriter = writer ?: throw serverNotRunning(request.method)
    val currentPump = pump ?: throw serverNotRunning(request.method)
    val expectedId = request.id?.jsonPrimitive?.content
    val pending =
      if (expectResponse && expectedId != null) PendingResponse(expectedId, currentPump) else null
    try {
      val requestBody = json.encodeToString(serializer<JsonRpcRequest>(), request)
      currentWriter.write(requestBody)
      currentWriter.newLine()
      currentWriter.flush()
    } catch (e: IOException) {
      // A closed pipe means the child is gone; drop it so the next request starts a new one.
      pending?.abandon()
      retireProcess(currentProcess, unexpected = true)
      terminateProcessTree(currentProcess)
      throw serverExited(request.method, e)
    } catch (e: Exception) {
      pending?.abandon()
      throw e
    }
    return DispatchedRequest(currentProcess, pending)
  }

  private fun awaitReply(
    request: JsonRpcRequest,
    pending: PendingResponse,
    currentProcess: Process,
    timeoutMs: Long?,
  ): JsonRpcResponse {
    try {
      val read = Callable { awaitResponse(pending, request.method, timeoutMs) }
      return responseReader.read(read, timeoutMs)
    } catch (_: java.util.concurrent.TimeoutException) {
      pending.abandon()
      // Only a request with a deadline (status probes) restarts the server; the next request
      // starts a fresh process. The old pump stays blocked on the old pipe until it is destroyed.
      discardProcess(currentProcess)
      throw McpConnectionException(
        "MCP stdio request '${request.method}' timed out after ${timeoutMs}ms",
      )
    } catch (e: ExecutionException) {
      pending.abandon()
      val cause = e.cause
      if (cause is StdioClosedException) {
        // The pipe closed under an in-flight request: the child exited. Its outcome is unknown, so
        // fail it (never replay it); the next request starts a new child.
        synchronized(ioLock) { retireProcess(currentProcess, unexpected = true) }
        terminateProcessTree(currentProcess)
        throw serverExited(request.method, cause)
      }
      throw (cause as? Exception ?: e)
    } catch (e: Exception) {
      // Includes InterruptedException from a cancelled caller: stop waiting for this reply and
      // leave the server running; the late reply is dropped by id.
      pending.abandon()
      throw e
    }
  }

  private fun awaitResponse(
    pending: PendingResponse,
    method: String,
    timeoutMs: Long?,
  ): JsonRpcResponse {
    val response =
      if (timeoutMs == null) pending.future.get()
      else pending.future.get(timeoutMs, TimeUnit.MILLISECONDS)
    if (response.error != null) {
      throw McpConnectionException(
        "MCP stdio error ${response.error.code}: ${response.error.message}",
      )
    }
    response.resultFor(method)
    return response
  }

  /** Kills a wedged child on purpose. Not an unexpected exit, so it does not feed the throttle. */
  private fun discardProcess(currentProcess: Process) {
    synchronized(ioLock) { retireProcess(currentProcess, unexpected = false) }
    terminateProcessTree(currentProcess)
  }

  /**
   * Forgets [current] so the next request starts a new child. Must hold [ioLock]. Does nothing when
   * [current] was already replaced, so a death seen by several threads is counted once.
   */
  private fun retireProcess(current: Process, unexpected: Boolean) {
    if (process !== current) {
      return
    }
    if (unexpected) {
      restartGuard.recordExit(processStartedAtNanos)
    }
    process = null
    writer = null
    pump = null
    initialized = false
  }

  /**
   * Retires a child that has exited since the last request. Must hold [ioLock]. Returns whether one
   * was retired.
   */
  private fun reapIfExited(): Boolean {
    val current = process ?: return false
    if (current.isAlive) {
      return false
    }
    retireProcess(current, unexpected = true)
    return true
  }

  private fun assertRestartAllowed() {
    val waitMs = restartGuard.remainingCoolDownMs()
    if (waitMs > 0) {
      throw McpConnectionException(
        "MCP stdio server '$command' exited ${restartGuard.consecutiveQuickExits} times in a row " +
          "right after starting, so it is not being restarted for another " +
          "${(waitMs + 999) / 1000}s. Run the command in a terminal to see why it fails.",
      )
    }
  }

  private fun serverNotRunning(method: String) =
    McpConnectionException(
      "MCP stdio server '$command' is not running, so '$method' was not sent; " +
        "the next request starts a new server",
    )

  private fun serverExited(method: String, cause: Throwable) =
    McpConnectionException(
      "MCP stdio server '$command' exited while '$method' was pending. The request was not " +
        "retried because its outcome is unknown; the next request starts a new server",
      cause,
    )

  private class PendingResponse(private val id: String, private val pump: StdioResponsePump) {
    val future = pump.register(id)

    fun abandon() = pump.abandon(id)
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

  /** Starts the child unless one is running. Must hold [ioLock]. */
  private fun startProcess() {
    if (process != null) {
      return
    }

    val commandParts = parseCommand(command)
    if (commandParts.isEmpty()) {
      throw McpConnectionException("MCP stdio command is empty")
    }

    val newProcess =
      try {
        processStarter(commandParts)
      } catch (e: IOException) {
        restartGuard.recordExit(startedAtNanos = null)
        throw McpConnectionException(
          "MCP stdio command '$command' could not be started: ${e.message}",
          e,
        )
      }
    process = newProcess
    processStartedAtNanos = nowNanos()
    val newReader = BufferedReader(InputStreamReader(newProcess.inputStream))
    writer = BufferedWriter(OutputStreamWriter(newProcess.outputStream))
    pump = StdioResponsePump(newReader, json).also { it.start() }
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
}

fun interface StdioResponseReader {
  fun read(read: Callable<JsonRpcResponse>, timeoutMs: Long?): JsonRpcResponse
}
