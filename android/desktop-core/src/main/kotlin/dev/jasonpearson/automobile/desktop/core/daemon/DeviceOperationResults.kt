package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Transient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer

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
  } catch (e: SerializationException) {
    KillDeviceResult(success = false, message = e.message ?: "Failed to kill device")
  } catch (e: McpConnectionException) {
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

/** The failed [StartDeviceResult] for [error], keeping a cleanup refusal's retry hint. */
internal fun startDeviceFailure(error: Exception): StartDeviceResult =
  StartDeviceResult(
    success = false,
    message = error.message ?: "Failed to start device",
    cleanupRetryAfterMs = error.deviceCleanupRetryAfterMs(),
  )

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
