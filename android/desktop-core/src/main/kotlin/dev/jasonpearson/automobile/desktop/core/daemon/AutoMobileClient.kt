package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
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

  fun setActiveDeviceChecked(deviceId: String, platform: String) {
    val result = setActiveDevice(deviceId, platform)
    if (!result.success) {
      throw McpConnectionException(result.message ?: "Failed to set active device")
    }
  }

  fun observe(platform: String = "android"): ObserveResult

  fun killDevice(name: String, deviceId: String, platform: String): KillDeviceResult

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

  fun setKeyValue(
    deviceId: String,
    appId: String,
    fileName: String,
    key: String,
    value: String?,
    type: String,
    platform: String = "android",
  ): SetKeyValueResult

  fun removeKeyValue(
    deviceId: String,
    appId: String,
    fileName: String,
    key: String,
    platform: String = "android",
  ): RemoveKeyValueResult

  fun clearKeyValueFile(
    deviceId: String,
    appId: String,
    fileName: String,
    platform: String = "android",
  ): ClearKeyValueResult

  fun callTool(name: String, arguments: JsonObject): JsonElement

  /**
   * Calls a tool whose JSON payload follows the daemon's `{success, message}` operation-result
   * convention and turns operational or MCP envelope failures into the same exception path as
   * transport errors.
   */
  fun callToolChecked(name: String, arguments: JsonObject): JsonElement {
    val response =
      callTool(name, arguments) as? JsonObject
        ?: throw McpConnectionException("Tool response was not an object")
    val envelopeError = response["isError"]?.jsonPrimitive?.booleanOrNull == true
    val text =
      response["content"]
        ?.let { content ->
          (content as? JsonArray)?.firstOrNull { item ->
            (item as? JsonObject)?.get("type")?.jsonPrimitive?.content == "text"
          }
        }
        ?.let { (it as? JsonObject)?.get("text")?.jsonPrimitive?.content }
        ?: throw McpConnectionException("Tool response missing text content")
    val payload = DaemonJson.decodeFromString<JsonElement>(text)
    val payloadObject = payload as? JsonObject ?: return payload
    val success = payloadObject["success"]?.jsonPrimitive?.booleanOrNull
    if (envelopeError || success == false) {
      val message =
        payloadObject["error"]?.jsonPrimitive?.contentOrNull
          ?: payloadObject["message"]?.jsonPrimitive?.contentOrNull
          ?: payloadObject["reason"]?.jsonPrimitive?.contentOrNull
          ?: payloadObject["code"]?.jsonPrimitive?.contentOrNull
          ?: "Tool operation failed"
      throw McpConnectionException(message)
    }
    return payload
  }

  /** Enable one optional server capability for this client connection. */
  fun enableToolCapability(capability: String) {
    try {
      callTool(
        "setToolCapability",
        buildJsonObject {
          put("capability", capability)
          put("enabled", true)
        },
      )
    } catch (error: McpConnectionException) {
      if (error.message?.contains("unknown tool", ignoreCase = true) != true) throw error
    }
  }

  fun close() {}
}

@Serializable
data class KillDeviceResult(
  val success: Boolean = true,
  val message: String? = null,
)

@Serializable
data class UpdateServiceResult(
  val success: Boolean = true,
  val message: String? = null,
)

@Serializable
data class SetKeyValueResult(
  val success: Boolean = true,
  val message: String? = null,
)

@Serializable
data class RemoveKeyValueResult(
  val success: Boolean = true,
  val message: String? = null,
)

@Serializable
data class ClearKeyValueResult(
  val success: Boolean = true,
  val message: String? = null,
)

@Serializable
data class StartDeviceResult(
  val success: Boolean = true,
  val deviceId: String? = null,
  val message: String? = null,
)

@Serializable
data class SetActiveDeviceResult(
  val success: Boolean = true,
  val message: String? = null,
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
)

internal fun unsupportedInputAction(transportName: String, action: String): InputActionResult =
  InputActionResult(
    action = action,
    success = false,
    error = "$transportName does not support direct daemon input helpers",
  )

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

@Serializable data class McpToolResponse(val content: List<McpToolContent>)

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
          "${SUPPORTED_MCP_PROTOCOL_VERSIONS.sorted()}. Update the AutoMobile daemon."
      )
  if (negotiated !in SUPPORTED_MCP_PROTOCOL_VERSIONS) {
    throw McpConnectionException(
      "Daemon negotiated unsupported MCP protocol version '$negotiated'. This desktop build " +
        "speaks ${SUPPORTED_MCP_PROTOCOL_VERSIONS.sorted()}. Update the AutoMobile desktop app."
    )
  }
  return negotiated
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
  return json.decodeFromString(serializer, text)
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
