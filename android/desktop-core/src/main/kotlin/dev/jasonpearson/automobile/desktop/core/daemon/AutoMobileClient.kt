package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

interface AutoMobileClient {
  val transportName: String
  val connectionDescription: String

  fun ping()

  fun listResources(): List<McpResource>

  fun listResourceTemplates(): List<McpResourceTemplate>

  fun listTools(): List<McpTool>

  fun readResource(uri: String): List<McpResourceContent>

  fun getNavigationGraph(platform: String = "android"): JsonElement

  fun listFeatureFlags(): List<FeatureFlagState>

  fun setFeatureFlag(key: String, enabled: Boolean, config: JsonObject? = null): FeatureFlagState

  fun listPerformanceAuditResults(
    startTime: String? = null,
    endTime: String? = null,
    limit: Int? = null,
    offset: Int? = null,
    deviceId: String? = null,
  ): PerformanceAuditHistoryResult

  fun getTestTimings(query: TestTimingQuery = TestTimingQuery()): TestTimingSummary

  fun getTestRuns(query: TestRunQuery = TestRunQuery()): TestRunSummary

  fun startTestRecording(platform: String = "android"): TestRecordingStartResult

  fun stopTestRecording(
    recordingId: String? = null,
    planName: String? = null,
  ): TestRecordingStopResult

  fun executePlan(
    planContent: String,
    platform: String = "android",
    startStep: Int? = null,
    sessionUuid: String? = null,
  ): ExecutePlanResult

  fun startDevice(
    name: String,
    platform: String,
    deviceId: String? = null,
  ): StartDeviceResult

  fun setActiveDevice(deviceId: String, platform: String): SetActiveDeviceResult

  fun observe(platform: String = "android"): ObserveResult

  /**
   * Stops a device.
   *
   * @param force skips the emulator-console AVD-name confirmation and acts on the serial as given
   *   (auto-mobile #6864). Only meaningful for a wedged Android emulator; accepted and ignored for
   *   iOS and physical devices. It does not override the conflict check, it removes it.
   */
  fun killDevice(
    name: String,
    deviceId: String,
    platform: String,
    force: Boolean = false,
  ): KillDeviceResult

  fun getDaemonStatus(): dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse

  fun updateService(deviceId: String, platform: String): UpdateServiceResult

  fun inputTap(
    x: Double,
    y: Double,
    platform: String = "android",
    deviceId: String? = null,
    duration: Int? = null,
    frameContext: String? = null,
  ): InputActionResult

  fun inputSwipe(
    startX: Double,
    startY: Double,
    endX: Double,
    endY: Double,
    platform: String = "android",
    deviceId: String? = null,
    durationMs: Int? = null,
    frameContext: String? = null,
  ): InputActionResult

  fun inputPressButton(
    button: String,
    platform: String = "android",
    deviceId: String? = null,
    frameContext: String? = null,
  ): InputActionResult

  /**
   * @param append when true, requests the daemon's non-destructive append mode: the text is added
   *   to the focused field with real key events instead of REPLACING its contents via
   *   `ACTION_SET_TEXT`. Required by any client mirroring a keyboard one keystroke at a time, which
   *   would otherwise leave only the last character typed. Android-only; the daemon rejects it on
   *   iOS (issue #3351).
   */
  fun inputTypeText(
    text: String,
    platform: String = "android",
    deviceId: String? = null,
    submit: Boolean? = null,
    append: Boolean = false,
    frameContext: String? = null,
  ): InputActionResult

  fun inputKey(
    key: String,
    platform: String = "android",
    deviceId: String? = null,
    frameContext: String? = null,
  ): InputActionResult

  /**
   * Open a persistent connection for one streamed (real-time) gesture — a drag delivered as a down,
   * incremental moves, and an up over a single held connection, so the device tracks the pointer
   * live instead of receiving one atomic `input/swipe` on release.
   *
   * Returns null when streaming is unavailable — the transport can't hold a connection open (HTTP /
   * stdio), the daemon does not advertise `input/gestureStream`, or the platform is not Android —
   * in which case the caller falls back to [inputSwipe]. The default is null so only the
   * Unix-socket client implements it; every other transport degrades cleanly (issue: streaming
   * gesture input).
   */
  fun openGestureStream(
    platform: String = "android",
    deviceId: String? = null,
  ): GestureInputStream? = null

  fun setKeyValue(
    deviceId: String,
    appId: String,
    fileName: String,
    key: String,
    value: String?,
    type: String,
    platform: String = "android",
    sessionUuid: String? = null,
  ): SetKeyValueResult

  fun removeKeyValue(
    deviceId: String,
    appId: String,
    fileName: String,
    key: String,
    platform: String = "android",
    sessionUuid: String? = null,
  ): RemoveKeyValueResult

  fun clearKeyValueFile(
    deviceId: String,
    appId: String,
    fileName: String,
    platform: String = "android",
    sessionUuid: String? = null,
  ): ClearKeyValueResult

  fun callTool(name: String, arguments: JsonObject): JsonElement

  /**
   * Calls a tool whose JSON payload follows the daemon's `{success, message}` operation-result
   * convention and turns operational or MCP envelope failures into the same exception path as
   * transport errors.
   */
  fun callToolChecked(name: String, arguments: JsonObject): JsonElement {
    return checkToolResponse(callTool(name, arguments), DaemonJson)
  }

  /** Set one exact server tool for this client connection. */
  fun setToolEnabled(
    toolName: String,
    enabled: Boolean = true,
  ) {
    checkToolResponse(
      callTool(
        "setToolEnabled",
        buildJsonObject {
          put("toolName", toolName)
          put("enabled", enabled)
        },
      ),
      DaemonJson,
    )
  }

  fun close() {}
}

internal fun checkToolResponse(responseElement: JsonElement, json: Json): JsonElement {
  val response =
    responseElement as? JsonObject
      ?: throw McpConnectionException("Tool response was not an object")
  val envelopeError = (response["isError"] as? JsonPrimitive)?.booleanOrNull == true
  val text =
    response["content"]
      ?.let { content ->
        (content as? JsonArray)?.firstOrNull { item ->
          (item as? JsonObject)?.get("type")?.jsonPrimitive?.content == "text"
        }
      }
      ?.let { ((it as? JsonObject)?.get("text") as? JsonPrimitive)?.contentOrNull }
      ?: throw McpConnectionException("Tool response missing text content")
  val payload =
    try {
      json.decodeFromString<JsonElement>(text)
    } catch (error: Exception) {
      if (envelopeError) {
        throw toolError(json, text, error)
      }
      throw McpConnectionException("Tool response contained invalid JSON", error)
    }
  val payloadObject = payload as? JsonObject
  val success = (payloadObject?.get("success") as? JsonPrimitive)?.booleanOrNull
  if (envelopeError || success == false) {
    throw toolError(json, text)
  }
  return payload
}

@Serializable
data class KillDeviceResult(
  val success: Boolean = true,
  val message: String? = null,
  /**
   * The daemon's structured error code for a failed kill, e.g.
   * [DEVICE_OWNED_BY_OTHER_SESSION_CODE].
   */
  @Transient val code: String? = null,
)

/**
 * Decodes a `killDevice` tool response; a failure becomes an unsuccessful result that keeps the
 * daemon's error code, so a held-device refusal (#10785) stays distinguishable from other errors.
 */
internal fun decodeKillDeviceResponse(json: Json, response: JsonElement): KillDeviceResult =
  try {
    decodeToolResponse(json, response, serializer<KillDeviceResult>())
  } catch (e: Exception) {
    if (e is CancellationException) throw e
    KillDeviceResult(
      success = false,
      message = e.message ?: "Failed to kill device",
      code = (e as? McpToolErrorException)?.code,
    )
  }

@Serializable
data class UpdateServiceResult(
  val success: Boolean = true,
  val message: String? = null,
)

@Serializable
data class SetKeyValueResult(
  val success: Boolean = true,
  val message: String? = null,
  val warning: String? = null,
)

@Serializable
data class RemoveKeyValueResult(
  val success: Boolean = true,
  val message: String? = null,
  val warning: String? = null,
)

@Serializable
data class ClearKeyValueResult(
  val success: Boolean = true,
  val message: String? = null,
  val warning: String? = null,
)

@Serializable data class StartDeviceRuntime(val deviceId: String? = null)

@Serializable
data class StartDeviceResult(
  val success: Boolean = true,
  val deviceId: String? = null,
  val runtime: StartDeviceRuntime? = null,
  val message: String? = null,
) {
  val resolvedDeviceId: String?
    get() = runtime?.deviceId ?: deviceId
}

@Serializable
data class SetActiveDeviceResult(
  val success: Boolean = true,
  val message: String? = null,
  /** Why the daemon refused, when it is a refusal the session loop acts on (#10682). */
  @Transient val refusal: SetActiveDeviceRefusal? = null,
)

@Serializable
data class ObserveResult(
  val updatedAt: Long? = null,
  val screenSize: ObserveScreenSize? = null,
  val viewHierarchy: JsonElement? = null,
  /** Display rotation: 0=portrait, 1=landscape 90deg, 2=reverse portrait, 3=reverse landscape */
  val rotation: Int? = null,
)

@Serializable
data class ObserveScreenSize(
  val width: Int? = null,
  val height: Int? = null,
)

@Serializable
data class InputCoordinates(
  val x: Double,
  val y: Double,
)

@Serializable
data class InputActionResult(
  val action: String,
  val success: Boolean,
  val platform: String? = null,
  val deviceId: String? = null,
  val error: String? = null,
  val coordinates: InputCoordinates? = null,
  val start: InputCoordinates? = null,
  val end: InputCoordinates? = null,
  val durationMs: Int? = null,
  val button: String? = null,
  val textLength: Int? = null,
  val submitted: Boolean? = null,
  val key: String? = null,
  /**
   * The daemon's structured code for a refused input, e.g. [DEVICE_OWNED_BY_OTHER_SESSION_CODE]
   * (#10698). Read from the socket response, not the result body.
   */
  val code: String? = null,
)

internal fun unsupportedInputAction(transportName: String, action: String): InputActionResult =
  InputActionResult(
    action = action,
    success = false,
    error = "$transportName does not support direct daemon input helpers",
  )

/**
 * A persistent connection for one streamed gesture, from [AutoMobileClient.openGestureStream]. The
 * caller sends exactly one [start], then any number of [move]s, then one [end], all sharing a
 * single `gestureId`, and finally [close]s the stream. Each call returns the frame's ack; a failed
 * ack (or a thrown transport error) means the connection is dead and the caller should stop and
 * fall back. Not thread-safe: drive it from one thread (the control dispatch consumer).
 */
interface GestureInputStream : AutoCloseable {
  /** Finger down at ([x], [y]). Call once, first. */
  fun start(gestureId: String, x: Double, y: Double): InputActionResult

  /** One incremental move to ([x], [y]). */
  fun move(gestureId: String, x: Double, y: Double): InputActionResult

  /** Lift at ([x], [y]); [cancel] abandons the drag and lifts in place. Call once, last. */
  fun end(gestureId: String, x: Double, y: Double, cancel: Boolean): InputActionResult

  override fun close()
}

open class McpConnectionException(message: String, cause: Throwable? = null) :
  Exception(message, cause)

@Serializable
data class McpResource(
  val uri: String,
  val name: String,
  val description: String? = null,
  val mimeType: String? = null,
)

@Serializable
data class McpResourceTemplate(
  @SerialName("uriTemplate") val uriTemplate: String,
  val name: String,
  val description: String? = null,
  val mimeType: String? = null,
)

@Serializable
data class McpTool(
  val name: String,
  val description: String? = null,
  val inputSchema: JsonObject? = null,
)

@Serializable
data class McpResourceContent(
  val uri: String,
  val mimeType: String? = null,
  val text: String? = null,
  val blob: String? = null,
)

@Serializable
data class McpToolContent(
  val type: String,
  val text: String? = null,
)

@Serializable
data class McpToolResponse(
  val content: List<McpToolContent>,
  val isError: Boolean = false,
)

@Serializable
data class FeatureFlagState(
  val key: String,
  val label: String,
  val description: String? = null,
  val enabled: Boolean,
  val config: JsonObject? = null,
)

@Serializable data class FeatureFlagListResult(val flags: List<FeatureFlagState>)

@Serializable
data class JsonRpcRequest(
  @EncodeDefault(EncodeDefault.Mode.NEVER) val jsonrpc: String = "2.0",
  val id: JsonElement? = null,
  val method: String,
  val params: JsonElement? = null,
)

@Serializable
data class JsonRpcResponse(
  val jsonrpc: String,
  val id: JsonElement? = null,
  val result: JsonElement? = null,
  val error: JsonRpcError? = null,
)

@Serializable
data class JsonRpcError(
  val code: Int,
  val message: String,
)

@Serializable internal data class ListResourcesResult(val resources: List<McpResource>)

@Serializable
internal data class ListResourceTemplatesResult(val resourceTemplates: List<McpResourceTemplate>)

@Serializable internal data class ListToolsResult(val tools: List<McpTool>)

@Serializable internal data class ReadResourceResult(val contents: List<McpResourceContent>)

internal const val LATEST_MCP_PROTOCOL_VERSION = "2025-11-25"

/**
 * MCP protocol revisions this client can speak. The client always offers
 * [LATEST_MCP_PROTOCOL_VERSION] on `initialize`; a server is free to answer with any revision it
 * prefers, and we accept anything in this set. The wire surface the desktop uses (`tools/list`,
 * `tools/call`, `resources/list`, `resources/read`) is unchanged across these revisions.
 */
internal val SUPPORTED_MCP_PROTOCOL_VERSIONS =
  setOf("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")

/** `clientInfo.name` reported to the daemon. This is the desktop app, not the IDE plugin. */
internal const val DESKTOP_CLIENT_NAME = "auto-mobile-desktop"

/** Params for the MCP `initialize` request, shared by the HTTP and STDIO clients. */
internal fun buildInitializeParams(): JsonObject = buildJsonObject {
  put("protocolVersion", JsonPrimitive(LATEST_MCP_PROTOCOL_VERSION))
  put("capabilities", JsonObject(emptyMap()))
  put(
    "clientInfo",
    buildJsonObject {
      put("name", JsonPrimitive(DESKTOP_CLIENT_NAME))
      put("version", JsonPrimitive(DesktopBuildInfo.VERSION))
    },
  )
}

/**
 * Reads the daemon's negotiated `protocolVersion` out of an `initialize` result and returns it.
 *
 * Throws [McpConnectionException] with actionable text when the daemon omits the field (it is
 * required by every MCP revision, so absence means a malformed server) or answers with a revision
 * this client does not implement — the alternative is silently speaking the wrong protocol.
 */
internal fun negotiateProtocolVersion(result: JsonObject): String {
  val negotiated =
    result["protocolVersion"]?.jsonPrimitive?.content
      ?: throw McpConnectionException(
        "Daemon's initialize response omitted protocolVersion. Expected one of " +
          "${SUPPORTED_MCP_PROTOCOL_VERSIONS.sorted()}. Update the AutoMobile daemon.",
      )
  if (negotiated !in SUPPORTED_MCP_PROTOCOL_VERSIONS) {
    throw McpConnectionException(
      "Daemon negotiated unsupported MCP protocol version '$negotiated'. This desktop build " +
        "speaks ${SUPPORTED_MCP_PROTOCOL_VERSIONS.sorted()}. Update the AutoMobile desktop app.",
    )
  }
  return negotiated
}

internal fun decodeObserveResponse(json: Json, element: JsonElement): ObserveResult {
  return try {
    decodeToolResponse(json, element, serializer<ObserveResult>())
  } catch (e: IllegalArgumentException) {
    // SerializationException is an IllegalArgumentException; connection errors and cancellation
    // propagate unchanged.
    throw McpConnectionException("Failed to decode observe response: ${e.message}", cause = e)
  }
}

internal fun <T> decodeToolResponse(
  json: Json,
  element: JsonElement,
  serializer: KSerializer<T>,
): T {
  val response = json.decodeFromJsonElement(serializer<McpToolResponse>(), element)
  val text =
    response.content.firstOrNull { it.type == "text" }?.text
      ?: throw McpConnectionException("Tool response missing text content")
  if (response.isError) {
    throw toolError(json, text)
  }
  return json.decodeFromString(serializer, text)
}

/**
 * The failure a tool error result reports, keeping the payload's structured `code` and `deviceId`
 * (a refusal is `{success:false, error, code, deviceId, retryable}`, `shapeToolCallError.ts`) so
 * callers can act on the code instead of the message.
 */
private fun toolError(json: Json, text: String, cause: Throwable? = null): McpToolErrorException {
  val payload = runCatching { json.decodeFromString<JsonElement>(text) }.getOrNull()
  val payloadObject = payload as? JsonObject
  val code = payloadObject?.let {
    (it["code"] as? JsonPrimitive)?.contentOrNull
      ?: ((it["failure"] as? JsonObject)?.get("code") as? JsonPrimitive)?.contentOrNull
  }
  val structuredMessage = payloadObject?.let {
    (it["error"] as? JsonPrimitive)?.contentOrNull
      ?: (it["message"] as? JsonPrimitive)?.contentOrNull
      ?: (it["reason"] as? JsonPrimitive)?.contentOrNull
      ?: (it["code"] as? JsonPrimitive)?.contentOrNull
  }
  return McpToolErrorException(
    message =
      structuredMessage ?: text.removePrefix("Error:").trim().ifBlank { "Tool operation failed" },
    code = code,
    deviceId = (payloadObject?.get("deviceId") as? JsonPrimitive)?.contentOrNull,
    cause = cause,
  )
}

internal fun <T> decodeResourceResponse(
  json: Json,
  contents: List<McpResourceContent>,
  serializer: KSerializer<T>,
): T {
  val text =
    contents.firstOrNull { !it.text.isNullOrBlank() }?.text
      ?: throw McpConnectionException("Resource response missing text content")
  val element = json.decodeFromString(serializer<JsonElement>(), text)
  val error = (element as? JsonObject)?.get("error")?.jsonPrimitive?.content
  if (!error.isNullOrBlank()) {
    throw McpConnectionException(error)
  }
  return json.decodeFromJsonElement(serializer, element)
}

/**
 * The `killDevice` tool arguments, shared by every transport so the three request builders cannot
 * drift apart. The tool defaults `force` to false, so only a forced kill puts the field on the wire
 * (auto-mobile #6864).
 */
internal fun killDeviceArguments(
  name: String,
  deviceId: String,
  platform: String,
  force: Boolean,
): JsonObject = buildJsonObject {
  put(
    "device",
    buildJsonObject {
      put("name", JsonPrimitive(name))
      put("deviceId", JsonPrimitive(deviceId))
      put("platform", JsonPrimitive(platform))
    },
  )
  if (force) {
    put("force", JsonPrimitive(true))
  }
}
