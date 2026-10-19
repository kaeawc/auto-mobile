import { InputDeviceOwnedError } from "./InputDeviceOwnedError";
import { DEVICE_CLEANUP_IN_PROGRESS_CODE } from "./DeviceCleanupInProgressError";
import { SESSION_CREATION_TIMEOUT_CODE } from "./SessionCreationTimeoutError";
import { DEVICE_OWNED_BY_OTHER_DAEMON_CODE } from "./DeviceOwnedByOtherDaemonError";
import { DEVICE_SHUTTING_DOWN_CODE } from "./DeviceShuttingDownError";
export {
  DEVICE_UNHEALTHY_CODE,
  DeviceUnhealthyError,
  type UnhealthyDeviceEvidence,
} from "./DeviceUnhealthyError";
export {
  DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS,
  RetryableDeviceAcquisitionError,
} from "./RetryableDeviceAcquisitionError";
export {
  DEVICE_CLEANUP_IN_PROGRESS_CODE,
  DeviceCleanupInProgressError,
} from "./DeviceCleanupInProgressError";
export { DEVICE_OFFLINE_CODE, DeviceTransportOfflineError } from "./DeviceTransportOfflineError";
export {
  SESSION_CREATION_TIMEOUT_CODE,
  SessionCreationTimeoutError,
} from "./SessionCreationTimeoutError";
export {
  DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
  DEVICE_OWNED_BY_OTHER_DAEMON_RETRY_AFTER_MS,
  DeviceOwnedByOtherDaemonError,
} from "./DeviceOwnedByOtherDaemonError";
export {
  DEVICE_SHUTTING_DOWN_CODE,
  DEVICE_SHUTTING_DOWN_RETRY_AFTER_MS,
  DeviceShuttingDownError,
} from "./DeviceShuttingDownError";
export {
  SESSION_RELEASED_DURING_CREATION_CODE,
  SessionReleasedDuringCreationError,
} from "./SessionReleasedDuringCreationError";

/**
 * The session UUID is under a kill's terminal release reservation (#11146), so it cannot be bound,
 * rebound or reserved again. Unlike `device_shutting_down` it is NOT retryable: the UUID ends with
 * that release, so only a new session UUID (or nothing, for a second kill) can follow (#11189).
 */
export const SESSION_TERMINAL_RELEASE_IN_PROGRESS_CODE = "session_terminal_release_in_progress";

// Defined beside its error class, which the input layer throws too (#11351).
export { SESSION_NO_LONGER_OWNS_DEVICE_CODE } from "./sessionNoLongerOwnsDevice";

/**
 * A kill's terminal-release reservation raced the session's own rebind (#11166). Retryable with a
 * `retryAfterMs` hint once the rebind settles, but deliberately NOT in
 * {@link RETRYABLE_DEVICE_ACQUISITION_CODES}: it refuses a destructive shutdown, not an
 * acquisition, and after the rebind the device may be unowned or held by another session, so the
 * caller (not a client loop) decides whether to kill again (#11189).
 */
export const SESSION_REBINDING_CODE = "session_rebinding";
/** A late tool call waits for recovery; this is not an acquisition refusal. */
export const SESSION_HELD_BY_RECOVERY_CODE = "session_held_by_recovery";

/** Wire codes of acquisition refusals a client should wait out rather than fail on. */
export const RETRYABLE_DEVICE_ACQUISITION_CODES: ReadonlySet<string> = new Set([
  DEVICE_CLEANUP_IN_PROGRESS_CODE,
  SESSION_CREATION_TIMEOUT_CODE,
  DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
  DEVICE_SHUTTING_DOWN_CODE,
]);

/**
 * A freshly started device turned out to be held by another session before the caller could
 * reserve it. When that holder is a session the daemon restored after a restart and is holding for
 * its previous owner, say so: "freshly started" reads as a race and hides the remedy (#11189).
 */
export function freshStartAlreadyBoundError(
  deviceId: string,
  holderSessionId: string,
  holderAwaitingOwner: boolean,
  retryAfterMs?: number,
): InputDeviceOwnedError {
  // Typed device_owned_by_other_session (#11351): clients branch on the code, not this wording.
  const refusal = (message: string) =>
    new InputDeviceOwnedError(
      "startDevice",
      deviceId,
      undefined,
      undefined,
      retryAfterMs === undefined
        ? message
        : `${message}${message.endsWith(".") ? "" : "."} The holder is being released; retry in about ${retryAfterMs}ms.`,
      retryAfterMs,
    );
  if (holderAwaitingOwner) {
    return refusal(
      `Device '${deviceId}' is reserved for session ${holderSessionId}, which the daemon restored ` +
        "after a restart and is holding for its previous owner to reconnect. If that session is " +
        `yours, pass sessionUuid ${holderSessionId} to reclaim it; otherwise wait for the ` +
        "reservation to lapse or use another device.",
    );
  }
  return refusal(
    `Freshly started device '${deviceId}' was assigned to session ` +
      `${holderSessionId} before its owning session could reserve it.`,
  );
}
