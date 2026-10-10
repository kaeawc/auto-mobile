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
 * The daemon's typed `code` for a bind refused because the device's previous session is still
 * finishing its release cleanup (#10960). The refusal carries `retryable: true` and `retryAfterMs`;
 * the caller waits and retries, the daemon never blocks the acquisition itself.
 */
const val DEVICE_CLEANUP_IN_PROGRESS_CODE = "device_cleanup_in_progress"

/**
 * The `nextAction` on every terminal session loss (`session_ownership_lost`,
 * `no_active_device_session`, `session_terminal_release_in_progress`): the session UUID is dead and
 * only a freshly acquired one can work. Always paired with `retryable: false`.
 */
const val NEXT_ACTION_ACQUIRE_NEW_SESSION = "acquire_new_session"

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
  /** The refusal's `retryAfterMs` hint, when it carried one. */
  val retryAfterMs: Long? = null,
  /** The refusal's `retryable` flag; null when the payload did not carry one. */
  val retryable: Boolean? = null,
  /** The refusal's `nextAction`, e.g. [NEXT_ACTION_ACQUIRE_NEW_SESSION]; null when absent. */
  val nextAction: String? = null,
) : McpConnectionException(message, cause)

/** True when the daemon said this session is terminal and only a new session UUID can proceed. */
fun Throwable.isSessionTerminalRefusal(): Boolean =
  (this as? McpToolErrorException)?.let {
    it.nextAction == NEXT_ACTION_ACQUIRE_NEW_SESSION && it.retryable != true
  } == true

/** True when this failure is the daemon refusing a device another session holds. */
fun Throwable.isDeviceOwnedRefusal(): Boolean =
  (this as? McpToolErrorException)?.code == DEVICE_OWNED_BY_OTHER_SESSION_CODE

/** True when the daemon refused this input because another session holds the device. */
val InputActionResult.isDeviceOwnedRefusal: Boolean
  get() = !success && code == DEVICE_OWNED_BY_OTHER_SESSION_CODE

/**
 * The wait, in milliseconds, before retrying a bind the daemon refused as
 * `device_cleanup_in_progress` (the hinted `retryAfterMs`, or [fallbackMs] when it gave none); null
 * for any other failure.
 */
fun Throwable.deviceCleanupRetryAfterMs(fallbackMs: Long = 1_000L): Long? =
  (this as? McpToolErrorException)
    ?.takeIf { it.code == DEVICE_CLEANUP_IN_PROGRESS_CODE }
    ?.let { it.retryAfterMs ?: fallbackMs }
