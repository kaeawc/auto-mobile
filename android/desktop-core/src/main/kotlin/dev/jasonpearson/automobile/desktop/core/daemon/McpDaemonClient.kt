package dev.jasonpearson.automobile.desktop.core.daemon

import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.UnixDomainSocketAddress
import java.nio.channels.Channels
import java.nio.channels.SocketChannel
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer

private const val DAEMON_CAPABILITIES_METHOD = "daemon/capabilities"
private const val INPUT_TYPE_TEXT_APPEND_CAPABILITY = "input/typeText.mode:append"
private const val INPUT_GESTURE_STREAM_CAPABILITY = "input/gestureStream"
private const val OLD_DAEMON_CAPABILITIES_ERROR = "Unsupported daemon method: daemon/capabilities"
private const val OLD_DAEMON_APPEND_MODE_ERROR = "input/typeText unsupported params: mode"
private const val UNSUPPORTED_APPEND_MODE_ERROR =
  "The connected daemon does not support input/typeText mode:append. Restart or update the daemon before typing into the device."
private const val SET_TOOL_ENABLED_TOOL_NAME = "setToolEnabled"
private const val DAEMON_TOOL_SELECTION_PROFILE_PARAM = "__autoMobileToolSelectionProfileUuid"

class McpDaemonClient(
  private val socketPathValue: String = DaemonSocketPaths.socketPath(),
  private val json: Json = DaemonJson,
  private val clientVersion: String? = DaemonSocketPaths.resolveClientVersion(),
  val sessionUuid: String? = null,
  /**
   * Hang ceiling for the input helpers (tap/swipe/key) ONLY. The request socket is a BLOCKING
   * [SocketChannel] — which supports no connect/read timeout — so without a deadline a daemon that
   * accepts but never replies (wedged event loop, half-open socket after sleep/wake) hangs the
   * calling thread FOREVER. For the video pane that thread is the single dispatch thread, held in
   * its FIFO mutex: one hung input call silently killed ALL further input. A watchdog fails the one
   * call at this deadline so the dispatcher sheds it and the next input proceeds on a fresh
   * connection. A hang detector, not a latency budget — a healthy input round-trip is ~ms. Ordinary
   * tool calls are deliberately UNBOUNDED (see [sendRequest]) so the daemon's long-running-tool
   * timeout floors are honored.
   */
  private val inputRequestTimeoutMs: Long = INPUT_REQUEST_TIMEOUT_MS,
  private val statusRequestTimeoutMs: Long = STATUS_REQUEST_TIMEOUT_MS,
) : AutoMobileClient {
  private var daemonLifecycle: DaemonLifecycleEnsurer? =
    if (socketPathValue == DaemonSocketPaths.socketPath()) DesktopDaemonLifecycle() else null

  internal constructor(
    socketPathValue: String,
    daemonLifecycle: DaemonLifecycleEnsurer,
    statusRequestTimeoutMs: Long = STATUS_REQUEST_TIMEOUT_MS,
  ) : this(socketPathValue = socketPathValue, statusRequestTimeoutMs = statusRequestTimeoutMs) {
    this.daemonLifecycle = daemonLifecycle
  }

  val socketPath: String
    get() = socketPathValue

  override val transportName: String = "Unix Socket"
  override val connectionDescription: String
    get() = socketPathValue

  private val testRecordingClient = TestRecordingSocketClient()
  private var daemonCapabilities: CachedDaemonCapabilities? = null
  private var toolSelectionProfileUuid: String? = null

  override fun ping() {
    val response = sendRequest("ide/ping")
    ensureSuccess(response)
  }

  override fun listResources(): List<McpResource> {
    val response = sendRequest("resources/list")
    ensureSuccess(response)
    val result = json.decodeFromJsonElement(serializer<ListResourcesResult>(), response.result!!)
    return result.resources
  }

  override fun listResourceTemplates(): List<McpResourceTemplate> {
    val response = sendRequest("resources/list-templates")
    ensureSuccess(response)
    val result =
      json.decodeFromJsonElement(serializer<ListResourceTemplatesResult>(), response.result!!)
    return result.resourceTemplates
  }

  override fun listTools(): List<McpTool> {
    val response =
      sendRequest(
        "tools/list",
        toolSelectionProfileUuid?.let { profileUuid ->
          buildJsonObject {
            put(DAEMON_TOOL_SELECTION_PROFILE_PARAM, JsonPrimitive(profileUuid))
          }
        } ?: JsonObject(emptyMap()),
      )
    ensureSuccess(response)
    val result = json.decodeFromJsonElement(serializer<ListToolsResult>(), response.result!!)
    return result.tools
  }

  override fun readResource(uri: String): List<McpResourceContent> {
    val response =
      sendRequest(
        "resources/read",
        buildJsonObject { put("uri", JsonPrimitive(uri)) },
      )
    ensureSuccess(response)
    val result = json.decodeFromJsonElement(serializer<ReadResourceResult>(), response.result!!)
    return result.contents
  }

  override fun getNavigationGraph(platform: String): JsonElement {
    val response =
      sendRequest(
        "ide/getNavigationGraph",
        buildJsonObject { put("platform", JsonPrimitive(platform)) },
      )
    ensureSuccess(response)
    return response.result ?: JsonObject(emptyMap())
  }

  override fun listFeatureFlags(): List<FeatureFlagState> {
    val response = sendRequest("ide/listFeatureFlags")
    ensureSuccess(response)
    val result = json.decodeFromJsonElement(serializer<FeatureFlagListResult>(), response.result!!)
    return result.flags
  }

  override fun setFeatureFlag(
    key: String,
    enabled: Boolean,
    config: JsonObject?,
  ): FeatureFlagState {
    val response =
      sendRequest(
        "ide/setFeatureFlag",
        buildJsonObject {
          put("key", JsonPrimitive(key))
          put("enabled", JsonPrimitive(enabled))
          if (config != null) {
            put("config", config)
          }
        },
      )
    ensureSuccess(response)
    return json.decodeFromJsonElement(serializer<FeatureFlagState>(), response.result!!)
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
    // Hang ceiling on the status probe (#4858). The blocking SocketChannel read is not cancellable
    // by coroutine cancellation, so a wrapping withTimeout at the caller cannot unblock a daemon
    // that accepts but never replies — only this watchdog, which closes the socket, can. A healthy
    // ide/status round-trip is ~ms, so a deadline here bounds the connectivity dot without risking
    // a
    // slow ordinary tool call (those stay unbounded; see [sendRequest]).
    val response =
      sendRequest(
        "ide/status",
        timeoutMs = statusRequestTimeoutMs,
        skipLifecyclePreflight = true,
      )
    ensureSuccess(response)
    return json.decodeFromJsonElement(
      serializer<dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse>(),
      response.result!!,
    )
  }

  override fun updateService(deviceId: String, platform: String): UpdateServiceResult {
    val response =
      sendRequest(
        "ide/updateService",
        buildJsonObject {
          put("deviceId", JsonPrimitive(deviceId))
          put("platform", JsonPrimitive(platform))
        },
      )
    ensureSuccess(response)
    return json.decodeFromJsonElement(serializer<UpdateServiceResult>(), response.result!!)
  }

  override fun inputTap(
    x: Double,
    y: Double,
    platform: String,
    deviceId: String?,
    duration: Int?,
    frameContext: String?,
  ): InputActionResult {
    return sendInputRequest(
      "input/tap",
      buildJsonObject {
        put("platform", JsonPrimitive(platform))
        putOptionalString("deviceId", deviceId)
        put("x", JsonPrimitive(x))
        put("y", JsonPrimitive(y))
        putOptionalInt("duration", duration)
        putOptionalString("frameContext", frameContext)
      },
    )
  }

  override fun inputSwipe(
    startX: Double,
    startY: Double,
    endX: Double,
    endY: Double,
    platform: String,
    deviceId: String?,
    durationMs: Int?,
    frameContext: String?,
  ): InputActionResult {
    return sendInputRequest(
      "input/swipe",
      buildJsonObject {
        put("platform", JsonPrimitive(platform))
        putOptionalString("deviceId", deviceId)
        put("startX", JsonPrimitive(startX))
        put("startY", JsonPrimitive(startY))
        put("endX", JsonPrimitive(endX))
        put("endY", JsonPrimitive(endY))
        putOptionalInt("durationMs", durationMs)
        putOptionalString("frameContext", frameContext)
      },
    )
  }

  override fun inputPressButton(
    button: String,
    platform: String,
    deviceId: String?,
    frameContext: String?,
  ): InputActionResult {
    return sendInputRequest(
      "input/pressButton",
      buildJsonObject {
        put("platform", JsonPrimitive(platform))
        putOptionalString("deviceId", deviceId)
        put("button", JsonPrimitive(button))
        putOptionalString("frameContext", frameContext)
      },
    )
  }

  override fun inputTypeText(
    text: String,
    platform: String,
    deviceId: String?,
    submit: Boolean?,
    append: Boolean,
    frameContext: String?,
  ): InputActionResult {
    val appendSupportError = if (append) inputTypeTextAppendSupportError() else null
    if (appendSupportError != null) {
      return InputActionResult(
        action = "input/typeText",
        success = false,
        error = appendSupportError,
      )
    }
    return try {
      sendInputRequest(
          "input/typeText",
          buildJsonObject {
            put("platform", JsonPrimitive(platform))
            putOptionalString("deviceId", deviceId)
            put("text", JsonPrimitive(text))
            putOptionalBoolean("submit", submit)
            putOptionalString("frameContext", frameContext)
            // Omitted entirely when false: the daemon rejects unknown/!append values, and older
            // daemons reject the param outright.
            if (append) put("mode", JsonPrimitive("append"))
          },
        )
        .let { result ->
          if (append && result.error == OLD_DAEMON_APPEND_MODE_ERROR) {
            evictDaemonCapabilities()
            result.copy(error = UNSUPPORTED_APPEND_MODE_ERROR)
          } else {
            result
          }
        }
    } catch (error: Exception) {
      if (append) evictDaemonCapabilities()
      throw error
    }
  }

  override fun inputKey(
    key: String,
    platform: String,
    deviceId: String?,
    frameContext: String?,
  ): InputActionResult {
    return sendInputRequest(
      "input/key",
      buildJsonObject {
        put("platform", JsonPrimitive(platform))
        putOptionalString("deviceId", deviceId)
        put("key", JsonPrimitive(key))
        putOptionalString("frameContext", frameContext)
      },
    )
  }

  override fun openGestureStream(platform: String, deviceId: String?): GestureInputStream? {
    // Streaming has no XCUITest equivalent, and only this Unix-socket transport can hold a
    // connection open. Everything else falls back to the atomic swipe (the interface default).
    if (platform != "android") return null
    if (!daemonSupportsGestureStream()) return null
    return try {
      McpGestureInputStream(platform, deviceId, connectPersistentChannel())
    } catch (_: Exception) {
      // Could not establish the persistent connection; the caller falls back to inputSwipe.
      null
    }
  }

  /**
   * Whether the connected daemon advertises `input/gestureStream`. Mirrors the append-mode probe:
   * an older daemon answers the capability query with its unsupported-method envelope (→ false),
   * and a successful probe is cached only while the socket's file identity is unchanged.
   */
  private fun daemonSupportsGestureStream(): Boolean {
    val identity = socketIdentity()
    val capabilities =
      if (identity == null) {
        when (val probe = queryDaemonCapabilities(null)) {
          is DaemonCapabilitiesProbe.Available -> probe.capabilities
          DaemonCapabilitiesProbe.Legacy -> return false
          is DaemonCapabilitiesProbe.Failure -> return false
        }
      } else {
        daemonCapabilities?.takeIf { it.identity == identity }?.capabilities
          ?: sharedDaemonCapabilities[identity]
          ?: when (val probe = queryDaemonCapabilities(identity)) {
            is DaemonCapabilitiesProbe.Available -> probe.capabilities
            DaemonCapabilitiesProbe.Legacy -> return false
            is DaemonCapabilitiesProbe.Failure -> return false
          }
      }
    return INPUT_GESTURE_STREAM_CAPABILITY in capabilities
  }

  /**
   * A connected Unix-socket channel plus its line reader/writer, kept open across gesture frames.
   */
  private class PersistentChannel(
    val channel: SocketChannel,
    val reader: BufferedReader,
    val writer: BufferedWriter,
  )

  /**
   * Open one Unix-socket channel and leave it connected. Reuses [sendRequest]'s connect discipline
   * — open unconnected, arm a deadline watchdog before the blocking connect — so a wedged daemon
   * that never accepts cannot hang the caller forever.
   */
  private fun connectPersistentChannel(): PersistentChannel {
    ensureVersionMatchedDaemon()
    ensureSocketExists()
    val address = UnixDomainSocketAddress.of(socketPathValue)
    val channel = SocketChannel.open(java.net.StandardProtocolFamily.UNIX)
    val expired = java.util.concurrent.atomic.AtomicBoolean(false)
    val watchdog =
      requestWatchdog.schedule(
        {
          expired.set(true)
          try {
            channel.close()
          } catch (_: Exception) {
            // Best-effort; the caller owns the definitive close.
          }
        },
        inputRequestTimeoutMs,
        java.util.concurrent.TimeUnit.MILLISECONDS,
      )
    try {
      channel.connect(address)
      val reader =
        BufferedReader(InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8))
      val writer =
        BufferedWriter(
          OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8)
        )
      return PersistentChannel(channel, reader, writer)
    } catch (e: Exception) {
      try {
        channel.close()
      } catch (_: Exception) {
        // Best-effort cleanup after a failed connect.
      }
      if (expired.get()) {
        throw DaemonUnavailableException(
          "Gesture stream connect timed out after ${inputRequestTimeoutMs}ms"
        )
      }
      throw e
    } finally {
      watchdog.cancel(false)
    }
  }

  /**
   * One streamed gesture over a single held connection. Each frame writes one `input/gesture*` line
   * and reads its ack, under the same per-input hang ceiling as one-shot input calls (a hung frame
   * closes the channel, killing the stream so the caller falls back rather than freezing).
   */
  private inner class McpGestureInputStream(
    private val platform: String,
    private val deviceId: String?,
    private val connection: PersistentChannel,
  ) : GestureInputStream {
    override fun start(gestureId: String, x: Double, y: Double): InputActionResult =
      sendFrame("input/gestureStart") {
        put("platform", JsonPrimitive(platform))
        putOptionalString("deviceId", deviceId)
        put("gestureId", JsonPrimitive(gestureId))
        put("x", JsonPrimitive(x))
        put("y", JsonPrimitive(y))
      }

    override fun move(gestureId: String, x: Double, y: Double): InputActionResult =
      sendFrame("input/gestureMove") {
        put("platform", JsonPrimitive(platform))
        putOptionalString("deviceId", deviceId)
        put("gestureId", JsonPrimitive(gestureId))
        put("x", JsonPrimitive(x))
        put("y", JsonPrimitive(y))
      }

    override fun end(
      gestureId: String,
      x: Double,
      y: Double,
      cancel: Boolean,
    ): InputActionResult =
      sendFrame("input/gestureEnd") {
        put("platform", JsonPrimitive(platform))
        putOptionalString("deviceId", deviceId)
        put("gestureId", JsonPrimitive(gestureId))
        put("x", JsonPrimitive(x))
        put("y", JsonPrimitive(y))
        put("cancel", JsonPrimitive(cancel))
      }

    override fun close() {
      try {
        connection.channel.close()
      } catch (_: Exception) {
        // Best-effort; the stream is being torn down regardless.
      }
    }

    private fun sendFrame(method: String, params: JsonObjectBuilder.() -> Unit): InputActionResult {
      val request =
        DaemonRequest(
          id = UUID.randomUUID().toString(),
          type = "mcp_request",
          method = method,
          params = buildJsonObject(params),
          clientVersion = clientVersion,
        )
      val expired = java.util.concurrent.atomic.AtomicBoolean(false)
      val watchdog =
        requestWatchdog.schedule(
          {
            expired.set(true)
            try {
              connection.channel.close()
            } catch (_: Exception) {
              // Best-effort; the frame call owns the definitive failure.
            }
          },
          inputRequestTimeoutMs,
          java.util.concurrent.TimeUnit.MILLISECONDS,
        )
      return try {
        connection.writer.write(json.encodeToString(request))
        connection.writer.newLine()
        connection.writer.flush()
        val line =
          connection.reader.readLine()
            ?: return InputActionResult(
              action = method,
              success = false,
              error = "Gesture stream closed",
            )
        val response = json.decodeFromString<DaemonResponse>(line)
        response.toInputActionResult(method)
      } catch (e: Exception) {
        val message =
          if (expired.get()) "Gesture frame '$method' timed out after ${inputRequestTimeoutMs}ms"
          else e.message ?: "Gesture frame '$method' failed"
        InputActionResult(action = method, success = false, error = message)
      } finally {
        watchdog.cancel(false)
      }
    }
  }

  private fun DaemonResponse.toInputActionResult(method: String): InputActionResult {
    if (!success) {
      return InputActionResult(action = method, success = false, error = error)
    }
    val body =
      result
        ?: return InputActionResult(
          action = method,
          success = false,
          error = "Daemon response missing result",
        )
    return json.decodeFromJsonElement(serializer<InputActionResult>(), body)
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
      sendRequest(
        "ide/setKeyValue",
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
    ensureSuccess(response)
    return try {
      json.decodeFromJsonElement(serializer<SetKeyValueResult>(), response.result!!)
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
      sendRequest(
        "ide/removeKeyValue",
        buildJsonObject {
          put("deviceId", JsonPrimitive(deviceId))
          put("platform", JsonPrimitive(platform))
          put("appId", JsonPrimitive(appId))
          put("fileName", JsonPrimitive(fileName))
          put("key", JsonPrimitive(key))
        },
      )
    ensureSuccess(response)
    return try {
      json.decodeFromJsonElement(serializer<RemoveKeyValueResult>(), response.result!!)
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
      sendRequest(
        "ide/clearKeyValueFile",
        buildJsonObject {
          put("deviceId", JsonPrimitive(deviceId))
          put("platform", JsonPrimitive(platform))
          put("appId", JsonPrimitive(appId))
          put("fileName", JsonPrimitive(fileName))
        },
      )
    ensureSuccess(response)
    return try {
      json.decodeFromJsonElement(serializer<ClearKeyValueResult>(), response.result!!)
    } catch (e: Exception) {
      ClearKeyValueResult(success = false, message = e.message ?: "Failed to clear key value file")
    }
  }

  override fun callTool(name: String, arguments: JsonObject): JsonElement {
    val sessionArguments =
      if (
        sessionUuid != null && name != SET_TOOL_ENABLED_TOOL_NAME && "sessionUuid" !in arguments
      ) {
        buildJsonObject {
          arguments.forEach { (key, value) -> put(key, value) }
          put("sessionUuid", JsonPrimitive(sessionUuid))
        }
      } else {
        arguments
      }
    val profileUuid = toolSelectionProfileUuid
    val routedArguments =
      if (name == SET_TOOL_ENABLED_TOOL_NAME || profileUuid == null) sessionArguments
      else
        buildJsonObject {
          sessionArguments.forEach { (key, value) -> put(key, value) }
          put(DAEMON_TOOL_SELECTION_PROFILE_PARAM, JsonPrimitive(profileUuid))
        }
    val response =
      sendRequest(
        "tools/call",
        buildJsonObject {
          put("name", JsonPrimitive(name))
          put("arguments", routedArguments)
        },
      )
    ensureSuccess(response)
    return response.result ?: JsonObject(emptyMap())
  }

  /** Releases this client's daemon session, if it owns one. */
  internal fun releaseSession() {
    val sessionId = sessionUuid ?: return
    val response =
      sendRequest(
        "daemon/releaseSession",
        buildJsonObject { put("sessionId", JsonPrimitive(sessionId)) },
      )
    ensureSuccess(response)
  }

  /** Refreshes the heartbeat for this client's daemon session, if it owns one. */
  internal fun heartbeatSession() {
    val sessionId = sessionUuid ?: return
    val response =
      sendRequest(
        "daemon/heartbeat",
        buildJsonObject { put("sessionId", JsonPrimitive(sessionId)) },
      )
    ensureSuccess(response)
  }

  override fun setToolEnabled(
    toolName: String,
    enabled: Boolean,
  ) {
    val response =
      callToolChecked(
        SET_TOOL_ENABLED_TOOL_NAME,
        buildJsonObject {
          put("toolName", JsonPrimitive(toolName))
          put("enabled", JsonPrimitive(enabled))
          toolSelectionProfileUuid?.let {
            put(DAEMON_TOOL_SELECTION_PROFILE_PARAM, JsonPrimitive(it))
          }
        },
      )
    toolSelectionProfileUuid =
      (response as? JsonObject)?.get("sessionUuid")?.jsonPrimitive?.contentOrNull
        ?: throw DaemonUnavailableException("Tool-selection response missing profile UUID")
  }

  private fun sendInputRequest(method: String, params: JsonObject): InputActionResult {
    // Input rides the tighter deadline: a hung input/* call froze the pane's whole input path
    // (single dispatch thread + FIFO mutex), and live interaction would rather shed one tap
    // after 5s than sit dead for a minute.
    val response = sendRequest(method, params, timeoutMs = inputRequestTimeoutMs)
    if (!response.success) {
      return InputActionResult(action = method, success = false, error = response.error)
    }
    val result =
      response.result
        ?: return InputActionResult(
          action = method,
          success = false,
          error = "Daemon response missing result",
        )
    val inputResult = json.decodeFromJsonElement(serializer<InputActionResult>(), result)
    if (inputResult.action != method) {
      return InputActionResult(
        action = method,
        success = false,
        error = "Daemon response action ${inputResult.action} did not match $method",
      )
    }
    return inputResult
  }

  /**
   * Reads the daemon's additive capability list before the desktop sends `mode: "append"`.
   *
   * An older daemon answers this query with its normal unsupported-method envelope. That leaves
   * append support unknown, so the client attempts the non-destructive append request and
   * translates only its exact unsupported-parameter response. Other probe failures, including
   * version mismatches, are preserved. Successful responses are shared only while the Unix socket's
   * file identity is unchanged, so the per-action facade clients in the control queue reuse one
   * probe without trusting a daemon restarted at the same pathname. An unsupported older daemon is
   * deliberately not cached so restarting it lets the next keystroke discover the upgraded
   * capability.
   */
  private fun inputTypeTextAppendSupportError(): String? {
    val identity = socketIdentity()
    val capabilities =
      if (identity == null) {
        when (val probe = queryDaemonCapabilities(null)) {
          is DaemonCapabilitiesProbe.Available -> probe.capabilities
          DaemonCapabilitiesProbe.Legacy -> return null
          is DaemonCapabilitiesProbe.Failure -> return probe.error
        }
      } else {
        daemonCapabilities?.takeIf { it.identity == identity }?.capabilities
          ?: sharedDaemonCapabilities[identity]
          ?: when (val probe = queryDaemonCapabilities(identity)) {
            is DaemonCapabilitiesProbe.Available -> probe.capabilities
            DaemonCapabilitiesProbe.Legacy -> return null
            is DaemonCapabilitiesProbe.Failure -> return probe.error
          }
      }
    return if (INPUT_TYPE_TEXT_APPEND_CAPABILITY in capabilities) null
    else UNSUPPORTED_APPEND_MODE_ERROR
  }

  private fun queryDaemonCapabilities(identity: SocketIdentity?): DaemonCapabilitiesProbe {
    // This probe runs on the keyboard input path (inputTypeText append=true), which shares the
    // video pane's single FIFO dispatch thread. Bound it with the same input hang ceiling so a
    // never-replying daemon can't freeze keystrokes forever — the taps/keys deadline is useless if
    // its prerequisite blocks unbounded.
    val response = sendRequest(DAEMON_CAPABILITIES_METHOD, timeoutMs = inputRequestTimeoutMs)
    if (!response.success) {
      if (response.error == OLD_DAEMON_CAPABILITIES_ERROR) return DaemonCapabilitiesProbe.Legacy
      return DaemonCapabilitiesProbe.Failure(response.error ?: "Daemon capability probe failed.")
    }
    if (response.result == null) {
      return DaemonCapabilitiesProbe.Failure("Daemon capability probe returned no result.")
    }
    val capabilities =
      try {
        json
          .decodeFromJsonElement(serializer<DaemonCapabilitiesResult>(), response.result)
          .capabilities
      } catch (_: Exception) {
        return DaemonCapabilitiesProbe.Failure(
          "Daemon capability probe returned an invalid result."
        )
      }
    val resolved = capabilities.toSet()
    // A daemon restart can replace a socket at the same pathname between the probe and this
    // point. Only publish the result if the response came from the same socket identity.
    if (identity != null && socketIdentity() == identity) {
      daemonCapabilities = CachedDaemonCapabilities(identity, resolved)
      sharedDaemonCapabilities[identity] = resolved
    }
    return DaemonCapabilitiesProbe.Available(resolved)
  }

  private fun evictDaemonCapabilities() {
    daemonCapabilities?.identity?.let(sharedDaemonCapabilities::remove)
    daemonCapabilities = null
  }

  /** A socket pathname is not daemon identity: a restart can replace its inode. */
  private fun socketIdentity(): SocketIdentity? {
    val path = File(socketPathValue).toPath()
    return try {
      Files.readAttributes(path, BasicFileAttributes::class.java).fileKey()?.toString()?.let {
        SocketIdentity(socketPathValue, it)
      }
    } catch (_: Exception) {
      null
    }
  }

  /**
   * Send one request. [timeoutMs] is a HANG ceiling, not a latency budget, and is OPT-IN: null
   * (ordinary tool calls) leaves the request unbounded, because the daemon deliberately grants
   * long-running tools multi-minute floors (executePlan 600s, startDevice/launchApp/observe 90s;
   * see src/daemon/mcpRequestTimeout.ts) and a blanket client ceiling would disconnect a valid slow
   * call while it is still running. Only the input helpers pass a value, where a hang freezes the
   * video pane's single dispatch thread.
   */
  private fun sendRequest(
    method: String,
    params: JsonObject = JsonObject(emptyMap()),
    timeoutMs: Long? = null,
    skipLifecyclePreflight: Boolean = false,
  ): DaemonResponse {
    // Status is a passive health probe. Its purpose is to report a wedged daemon, so running the
    // lifecycle preflight first can itself hang before the request watchdog is armed.
    if (!skipLifecyclePreflight) {
      ensureVersionMatchedDaemon()
    }
    ensureSocketExists()

    val address = UnixDomainSocketAddress.of(socketPathValue)
    // Open the channel UNCONNECTED so the deadline can be armed BEFORE the blocking connect(): a
    // wedged daemon whose accept backlog is full would otherwise hang in connect() before any
    // watchdog exists.
    SocketChannel.open(java.net.StandardProtocolFamily.UNIX).use { channel ->
      // Deadline watchdog. A blocking SocketChannel has no connect/read timeout, so a daemon that
      // never accepts or never replies would hang the calling thread forever (for video-pane
      // input that meant ALL input died). The watchdog closes the channel, which makes the blocked
      // connect/read throw; `expired` is set BEFORE the close so the request thread
      // deterministically
      // reports the deadline rather than the incidental ClosedChannelException the close raced in.
      val expired = java.util.concurrent.atomic.AtomicBoolean(false)
      val watchdog = timeoutMs?.let { deadline ->
        requestWatchdog.schedule(
          {
            expired.set(true)
            try {
              channel.close()
            } catch (_: Exception) {
              // Best-effort close; the request thread owns the definitive close via use{}.
            }
          },
          deadline,
          java.util.concurrent.TimeUnit.MILLISECONDS,
        )
      }
      try {
        channel.connect(address)
        val reader =
          BufferedReader(
            InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8)
          )
        val writer =
          BufferedWriter(
            OutputStreamWriter(Channels.newOutputStream(channel), StandardCharsets.UTF_8)
          )

        val request =
          DaemonRequest(
            id = UUID.randomUUID().toString(),
            type = "mcp_request",
            method = method,
            params = params,
            clientVersion = clientVersion,
          )

        writer.write(json.encodeToString(request))
        writer.newLine()
        writer.flush()

        val line = reader.readLine() ?: throw DaemonUnavailableException("Daemon closed the socket")
        return json.decodeFromString(line)
      } catch (e: Exception) {
        if (expired.get()) {
          throw DaemonUnavailableException(
            "Daemon request '$method' timed out after ${timeoutMs}ms"
          )
        }
        throw e
      } finally {
        watchdog?.cancel(false)
      }
    }
  }

  private fun ensureSocketExists() {
    val path = File(socketPathValue).toPath()
    if (!Files.exists(path)) {
      throw DaemonUnavailableException("Daemon socket not found at $socketPathValue")
    }
  }

  private fun ensureVersionMatchedDaemon() {
    when (val result = daemonLifecycle?.ensureVersionMatchedDaemon()) {
      is DaemonLifecycleResult.Failure -> throw DaemonUnavailableException(result.message)
      is DaemonLifecycleResult.Ready,
      null -> Unit
    }
  }

  private fun ensureSuccess(response: DaemonResponse) {
    if (!response.success) {
      throw DaemonUnavailableException(response.error ?: "Daemon request failed")
    }
    if (response.result == null) {
      throw DaemonUnavailableException("Daemon response missing result")
    }
  }

  private fun JsonObjectBuilder.putOptionalString(
    key: String,
    value: String?,
  ) {
    if (value != null) {
      put(key, JsonPrimitive(value))
    }
  }

  private fun JsonObjectBuilder.putOptionalInt(
    key: String,
    value: Int?,
  ) {
    if (value != null) {
      put(key, JsonPrimitive(value))
    }
  }

  private fun JsonObjectBuilder.putOptionalBoolean(
    key: String,
    value: Boolean?,
  ) {
    if (value != null) {
      put(key, JsonPrimitive(value))
    }
  }

  companion object {
    /** Hang ceiling for ordinary daemon requests (tool calls can legitimately take tens of s). */
    /** Hang ceiling for the input helpers; a healthy input round-trip is ~milliseconds. */
    const val INPUT_REQUEST_TIMEOUT_MS = 5_000L

    /**
     * Hang ceiling for the daemon connectivity probe (ide/status); a healthy probe is ~ms (#4858).
     */
    const val STATUS_REQUEST_TIMEOUT_MS = 5_000L

    // One shared daemon thread arms/cancels every request deadline. It only ever runs a
    // channel.close() for a request that overran its ceiling, so it stays idle in normal use.
    private val requestWatchdog =
      java.util.concurrent.Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "daemon-request-watchdog").apply { isDaemon = true }
      }
  }
}

object DaemonSocketPaths {
  private val ignoredVersions = setOf("latest", "unknown")

  fun socketPath(): String {
    val userId = getUserId()
    return resolveDaemonPath(
      System.getenv("AUTOMOBILE_DAEMON_SOCKET_PATH")
        ?: System.getenv("AUTO_MOBILE_DAEMON_SOCKET_PATH"),
      "/tmp/auto-mobile-daemon-$userId.sock",
    )
  }

  fun pidFilePath(): String {
    val userId = getUserId()
    return resolveDaemonPath(
      System.getenv("AUTOMOBILE_DAEMON_PID_FILE_PATH")
        ?: System.getenv("AUTO_MOBILE_DAEMON_PID_FILE_PATH"),
      "/tmp/auto-mobile-daemon-$userId.pid",
      System.getenv("AUTOMOBILE_DAEMON_LAUNCH_CWD") ?: System.getProperty("user.dir", "."),
    )
  }

  internal fun resolveDaemonPath(
    override: String?,
    defaultPath: String,
    daemonLaunchCwd: String =
      System.getenv("AUTOMOBILE_DAEMON_LAUNCH_CWD") ?: System.getProperty("user.dir", "."),
  ): String {
    val configuredPath = override?.trim().takeUnless { it.isNullOrEmpty() } ?: return defaultPath
    val path = Path.of(configuredPath)
    return if (path.isAbsolute) configuredPath
    else Path.of(daemonLaunchCwd, configuredPath).toString()
  }

  /** Version this desktop client declares to the daemon's version handshake gate. */
  fun resolveClientVersion(): String? =
    resolveClientVersion(
      daemonPackageVersion = System.getenv("AUTOMOBILE_DAEMON_PACKAGE_VERSION"),
      automobileVersion = System.getenv("AUTOMOBILE_VERSION"),
      manifestVersion =
        DaemonSocketPaths::class.java.`package`?.implementationVersion ?: DesktopBuildInfo.VERSION,
    )

  internal fun resolveClientVersion(
    daemonPackageVersion: String?,
    automobileVersion: String?,
    manifestVersion: String?,
  ): String? =
    sequenceOf(daemonPackageVersion, automobileVersion, manifestVersion)
      .mapNotNull(::normalizeClientVersion)
      .firstOrNull()

  internal fun normalizeClientVersion(raw: String?): String? {
    val trimmed = raw?.trim().orEmpty()
    if (trimmed.isEmpty() || ignoredVersions.contains(trimmed.lowercase())) {
      return null
    }
    // A Gradle dev build stamps `<release>-SNAPSHOT` (e.g. `0.0.67-SNAPSHOT`). The daemon's
    // handshake gate compares release strings, and `-SNAPSHOT` is a semver prerelease — not `+`
    // build metadata — so an unstripped SNAPSHOT can never match the published daemon it tracks
    // (`0.0.67-SNAPSHOT` != `0.0.67`), and `bunx @kaeawc/auto-mobile@0.0.67-SNAPSHOT` names a
    // package that does not exist on npm. Declare the base release instead so a dev-run desktop
    // connects to the current installed daemon, and can install the real package when none runs.
    val snapshotBase =
      trimmed
        .takeIf { it.endsWith(SNAPSHOT_SUFFIX, ignoreCase = true) }
        ?.dropLast(SNAPSHOT_SUFFIX.length)
    if (snapshotBase != null) {
      return snapshotBase.takeIf { it.isNotEmpty() }
    }
    return trimmed
  }

  private const val SNAPSHOT_SUFFIX = "-SNAPSHOT"

  internal fun releaseVersion(version: String): String = version.substringBefore('+')

  private fun getUserId(): String {
    val userName = System.getProperty("user.name", "default").ifBlank { "default" }
    val osName = System.getProperty("os.name", "").lowercase()
    if (osName.contains("win")) {
      return userName
    }

    return try {
      val process = ProcessBuilder("id", "-u").start()
      val completed = process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)
      if (!completed) {
        process.destroy()
        return userName
      }
      val uid = process.inputStream.bufferedReader().readText().trim()
      if (uid.isNotEmpty()) uid else userName
    } catch (e: Exception) {
      userName
    }
  }
}

@Serializable
internal data class DaemonRequest(
  val id: String,
  val type: String,
  val method: String,
  val params: JsonObject,
  val clientVersion: String? = null,
)

@Serializable
data class DaemonResponse(
  val id: String,
  val type: String,
  val success: Boolean,
  val result: JsonElement? = null,
  val error: String? = null,
)

@Serializable private data class DaemonCapabilitiesResult(val capabilities: List<String>)

private data class SocketIdentity(
  val path: String,
  val fileKey: String,
)

private data class CachedDaemonCapabilities(
  val identity: SocketIdentity,
  val capabilities: Set<String>,
)

private sealed interface DaemonCapabilitiesProbe {
  data class Available(val capabilities: Set<String>) : DaemonCapabilitiesProbe

  data object Legacy : DaemonCapabilitiesProbe

  data class Failure(val error: String) : DaemonCapabilitiesProbe
}

private val sharedDaemonCapabilities = ConcurrentHashMap<SocketIdentity, Set<String>>()

class DaemonUnavailableException(message: String) : McpConnectionException(message)
