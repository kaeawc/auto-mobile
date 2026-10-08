package dev.jasonpearson.automobile.desktop.core.daemon

/**
 * The daemon's typed `code` for a call refused because another live session holds the target device
 * (#10698, #10783, #10785): an input frame (`input/tap` and the like) carries it on the socket
 * response, and a refused `tools/call` carries it in its error payload `{success:false, error,
 * code, deviceId, retryable}`. Match this code, never the message
 * (`src/daemon/inputDeviceOwnership.ts`).
 */
const val DEVICE_OWNED_BY_OTHER_SESSION_CODE = "device_owned_by_other_session"

/**
 * A tool call the daemon answered with an error result. [code] and [deviceId] are the structured
 * fields of the error payload, when it had them; [code] also reads a nested `failure.code`, where a
 * `deleteDevice` precondition failure puts it.
 */
class McpToolErrorException(
  message: String,
  val code: String? = null,
  val deviceId: String? = null,
  cause: Throwable? = null,
) : McpConnectionException(message, cause)

/** True when this failure is the daemon refusing a device another session holds. */
fun Throwable.isDeviceOwnedRefusal(): Boolean =
  (this as? McpToolErrorException)?.code == DEVICE_OWNED_BY_OTHER_SESSION_CODE

/** True when the daemon refused this input because another session holds the device. */
val InputActionResult.isDeviceOwnedRefusal: Boolean
  get() = !success && code == DEVICE_OWNED_BY_OTHER_SESSION_CODE
