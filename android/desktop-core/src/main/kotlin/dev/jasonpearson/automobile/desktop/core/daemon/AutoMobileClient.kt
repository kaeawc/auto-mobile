package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
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
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

interface AutoMobileClient :
  AutoMobileDeviceOperations,
  AutoMobileTestOperations,
  AutoMobileInputOperations,
  AutoMobileStorageOperations,
  AutoMobileFeatureOperations {
  val transportName: String
  val connectionDescription: String

  /**
   * The daemon session a device-targeted tool call through this client names, or null when it names
   * none. A caller that must address the call's result later, such as the owner of a started
   * recording, reads it here rather than from a registration-gated provider (#11366).
   */
  val actingSessionUuid: String?
    get() = null

  fun ping()

  fun listResources(): List<McpResource>

  fun listResourceTemplates(): List<McpResourceTemplate>

  fun listTools(): List<McpTool>

  fun readResource(uri: String): List<McpResourceContent>

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
    } catch (error: SerializationException) {
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
  /**
   * Set when the daemon refused the start as `device_cleanup_in_progress` (#10960): the wait in
   * milliseconds before retrying, once the device's previous session finishes cleaning up.
   */
  @Transient val cleanupRetryAfterMs: Long? = null,
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
  /** The failure frame's `retryable` flag; null when the daemon did not say. */
  val retryable: Boolean? = null,
  /**
   * How long to wait before retrying, from the failure frame's `details.remainingMs` (a suspect
   * session's remaining reservation); null when the frame carried none.
   */
  val retryAfterMs: Long? = null,
)

/**
 * Input-frame code for a session that missed a liveness heartbeat and is being restored: retryable
 * after [InputActionResult.retryAfterMs], the device stays reserved meanwhile.
 */
const val DAEMON_SESSION_SUSPECT_CODE = "daemon_session_suspect"

/**
 * The daemon's code for a session it no longer recognises as the device's owner. Terminal for that
 * session: only a freshly acquired session can send input again.
 */
const val SESSION_OWNERSHIP_LOST_CODE = "session_ownership_lost"

/** True when this input was refused because the session is suspect and will be restored. */
val InputActionResult.isSessionSuspect: Boolean
  get() = !success && code == DAEMON_SESSION_SUSPECT_CODE

/** True when this input was refused because the session lost ownership (terminal). */
val InputActionResult.isSessionOwnershipLost: Boolean
  get() = !success && code == SESSION_OWNERSHIP_LOST_CODE

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
 * The failure a tool error result reports, keeping the payload's structured `code`, `deviceId`,
 * `retryable`, `retryAfterMs` and `nextAction` so callers can act on them instead of the message.
 * The daemon puts these fields at the payload's top level (`{success:false, error, code,
 * retryable}`, `shapeToolCallError.ts`) or nested under `error` (`{error:{code, message, retryable,
 * nextAction}}`); both shapes exist on the wire, so each field is read from either.
 */
private fun toolError(json: Json, text: String, cause: Throwable? = null): McpToolErrorException {
  val payload = runCatching { json.decodeFromString<JsonElement>(text) }.getOrNull()
  val payloadObject = payload as? JsonObject
  val code = payloadObject?.let {
    refusalString(it, "code")
      ?: ((it["failure"] as? JsonObject)?.get("code") as? JsonPrimitive)?.contentOrNull
  }
  val structuredMessage = payloadObject?.let {
    (it["error"] as? JsonPrimitive)?.contentOrNull
      ?: ((it["error"] as? JsonObject)?.get("message") as? JsonPrimitive)?.contentOrNull
      ?: (it["message"] as? JsonPrimitive)?.contentOrNull
      ?: (it["reason"] as? JsonPrimitive)?.contentOrNull
      ?: code
  }
  return McpToolErrorException(
    message =
      structuredMessage ?: text.removePrefix("Error:").trim().ifBlank { "Tool operation failed" },
    code = code,
    deviceId = payloadObject?.let { refusalString(it, "deviceId") },
    cause = cause,
    details =
      McpRefusalDetails(
        retryAfterMs = payloadObject?.let { refusalPrimitive(it, "retryAfterMs")?.longOrNull },
        retryable = payloadObject?.let { refusalPrimitive(it, "retryable")?.booleanOrNull },
        nextAction = payloadObject?.let { refusalString(it, "nextAction") },
      ),
  )
}

/** A refusal field read from the payload's top level, else from its nested `error` object. */
internal fun refusalPrimitive(payload: JsonObject, name: String): JsonPrimitive? =
  (payload[name] as? JsonPrimitive)
    ?: ((payload["error"] as? JsonObject)?.get(name) as? JsonPrimitive)

internal fun refusalString(payload: JsonObject, name: String): String? =
  refusalPrimitive(payload, name)?.contentOrNull

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
