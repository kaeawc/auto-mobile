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
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer

private const val DAEMON_CAPABILITIES_METHOD = "daemon/capabilities"
private const val INPUT_TYPE_TEXT_APPEND_CAPABILITY = "input/typeText.mode:append"
private const val OLD_DAEMON_CAPABILITIES_ERROR = "Unsupported daemon method: daemon/capabilities"
private const val OLD_DAEMON_APPEND_MODE_ERROR = "input/typeText unsupported params: mode"
private const val UNSUPPORTED_APPEND_MODE_ERROR =
  "The connected daemon does not support input/typeText mode:append. Restart or update the daemon before typing into the device."
private const val SET_TOOL_CAPABILITY_TOOL_NAME = "setToolCapability"
private const val DAEMON_CAPABILITY_PROFILE_PARAM = "__autoMobileCapabilityProfileUuid"

@Serializable private data class CapabilityProfileResponse(val sessionUuid: String)

class McpDaemonClient(
  private val socketPathValue: String = DaemonSocketPaths.socketPath(),
  private val json: Json = DaemonJson,
  private val clientVersion: String? = DaemonSocketPaths.resolveClientVersion(),
  val sessionUuid: String? = null,
) : AutoMobileClient {
  private var daemonLifecycle: DaemonLifecycleEnsurer? =
    if (socketPathValue == DaemonSocketPaths.socketPath()) DesktopDaemonLifecycle() else null

  internal constructor(
    socketPathValue: String,
    daemonLifecycle: DaemonLifecycleEnsurer,
  ) : this(socketPathValue = socketPathValue) {
    this.daemonLifecycle = daemonLifecycle
  }

  val socketPath: String
    get() = socketPathValue

  override val transportName: String = "Unix Socket"
  override val connectionDescription: String
    get() = socketPathValue

  private val testRecordingClient = TestRecordingSocketClient()
  private var daemonCapabilities: CachedDaemonCapabilities? = null
  private var capabilityProfileUuid: String? = null

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
        capabilityProfileUuid?.let { profileUuid ->
          buildJsonObject {
            put(DAEMON_CAPABILITY_PROFILE_PARAM, JsonPrimitive(profileUuid))
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
    val response = sendRequest("ide/status")
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
        sessionUuid != null && name != SET_TOOL_CAPABILITY_TOOL_NAME && "sessionUuid" !in arguments
      ) {
        buildJsonObject {
          arguments.forEach { (key, value) -> put(key, value) }
          put("sessionUuid", JsonPrimitive(sessionUuid))
        }
      } else {
        arguments
      }
    val profileUuid = capabilityProfileUuid
    val routedArguments =
      if (name == SET_TOOL_CAPABILITY_TOOL_NAME || profileUuid == null) sessionArguments
      else
        buildJsonObject {
          sessionArguments.forEach { (key, value) -> put(key, value) }
          put(DAEMON_CAPABILITY_PROFILE_PARAM, JsonPrimitive(profileUuid))
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

  override fun enableToolCapability(capability: String) {
    val response =
      try {
        callTool(
          SET_TOOL_CAPABILITY_TOOL_NAME,
          buildJsonObject {
            put("capability", JsonPrimitive(capability))
            put("enabled", JsonPrimitive(true))
            capabilityProfileUuid?.let {
              put(DAEMON_CAPABILITY_PROFILE_PARAM, JsonPrimitive(it))
            }
          },
        )
      } catch (error: McpConnectionException) {
        if (error.message?.contains("unknown tool", ignoreCase = true) != true) throw error
        return
      }
    val text =
      response.jsonObject["content"]
        ?.jsonArray
        ?.firstOrNull { it.jsonObject["type"]?.jsonPrimitive?.content == "text" }
        ?.jsonObject
        ?.get("text")
        ?.jsonPrimitive
        ?.content
        ?: throw DaemonUnavailableException("Capability control response missing profile UUID")
    capabilityProfileUuid = json.decodeFromString<CapabilityProfileResponse>(text).sessionUuid
  }

  private fun sendInputRequest(method: String, params: JsonObject): InputActionResult {
    val response = sendRequest(method, params)
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
    val response = sendRequest(DAEMON_CAPABILITIES_METHOD)
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

  private fun sendRequest(
    method: String,
    params: JsonObject = JsonObject(emptyMap()),
  ): DaemonResponse {
    ensureVersionMatchedDaemon()
    ensureSocketExists()

    val address = UnixDomainSocketAddress.of(socketPathValue)
    SocketChannel.open(address).use { channel ->
      val reader =
        BufferedReader(InputStreamReader(Channels.newInputStream(channel), StandardCharsets.UTF_8))
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
    return trimmed
  }

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
