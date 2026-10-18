import { RetryableDeviceAcquisitionError } from "./RetryableDeviceAcquisitionError";

import { InputDeviceOwnedError } from "./inputDeviceOwnership";

/**
 * A device whose previous session is still finishing its release cleanup (restores, recording
 * finalize) cannot be bound yet (#10960). Clients wait on it the way they wait for a held device.
 */
export const DEVICE_CLEANUP_IN_PROGRESS_CODE = "device_cleanup_in_progress";

/** A health marker refuses allocation until recovery succeeds or the device is replaced (#12112). */
export const DEVICE_UNHEALTHY_CODE = "device_unhealthy";

export interface UnhealthyDeviceEvidence {
  readonly deviceId: string;
  readonly reason: string;
  readonly recovering: boolean;
  readonly retryAfterMs?: number;
}

/**
 * A session's creation did not finish within its deadline (a wedged DB write or a release of the
 * same UUID that never settled), so the bind was rolled back rather than hold the device and the
 * pool's assignment mutex (#10963). Retrying is safe.
 */
export const SESSION_CREATION_TIMEOUT_CODE = "session_creation_timeout";

/**
 * Another live AutoMobile daemon has claimed the device, so an explicit bind is refused (#10980,
 * owner decision 2026-10-09): two daemons must never drive the same device. Clients wait on it
 * like a held device; it frees once the other daemon releases its session.
 */
export const DEVICE_OWNED_BY_OTHER_DAEMON_CODE = "device_owned_by_other_daemon";

/**
 * The device is under a kill/shutdown reservation, so an acquisition or readiness step cannot
 * proceed. The reservation clears once the shutdown finishes (or fails), after which the device
 * can be acquired again, so clients wait on it like a held device.
 */
export const DEVICE_SHUTTING_DOWN_CODE = "device_shutting_down";

/** adb still lists the transport, but it has not returned online within the bind budget. */
export const DEVICE_OFFLINE_CODE = "device_offline";

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

/** Retry hint when nothing bounds the remaining wait more precisely. */
export const DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS = 1_000;

/** Retry hint for a device another daemon holds: its claim lapses only once that session ends. */
export const DEVICE_OWNED_BY_OTHER_DAEMON_RETRY_AFTER_MS = 2_000;

export class DeviceOwnedByOtherDaemonError extends RetryableDeviceAcquisitionError {
  /** @param remedy what the caller can do instead; defaults to the acquisition remedy */
  constructor(
    deviceId: string,
    readonly ownerPid: number | undefined,
    remedy = "Retry after that daemon releases it, or pick another device.",
  ) {
    super(
      DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
      deviceId,
      DEVICE_OWNED_BY_OTHER_DAEMON_RETRY_AFTER_MS,
      `Device '${deviceId}' is claimed by another AutoMobile daemon` +
        (ownerPid === undefined ? "" : ` (PID ${ownerPid})`) +
        ` (code ${DEVICE_OWNED_BY_OTHER_DAEMON_CODE}); two daemons must never drive the same ` +
        `device. ${remedy}`,
    );
    this.name = "DeviceOwnedByOtherDaemonError";
  }
}

/**
 * Retry hint for a device under shutdown: a kill normally finishes within a few seconds. It is a
 * polling interval, not a remaining time like `device_cleanup_in_progress` carries (#11616): a
 * shutdown reservation spans several separately bounded steps and records no deadline, so the
 * refusal has no bound to report. Each usable hint extends the runners' total wait using
 * max(30 s, min(waited + retryAfterMs, 150 s)), up to the 150 s cap. The 30 s floor alone
 * applies only when the refusal carries no usable hint.
 */
export const DEVICE_SHUTTING_DOWN_RETRY_AFTER_MS = 2_000;

/**
 * A session that was being created on demand was released before its creation returned (for
 * example an executePlan label session whose base was released mid-setup, #11146). The caller lost
 * the race; nothing is bound under its UUID.
 */
export const SESSION_RELEASED_DURING_CREATION_CODE = "session_released_during_creation";
