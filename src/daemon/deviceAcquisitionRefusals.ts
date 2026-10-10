import { ActionableError } from "../models/ActionableError";

/**
 * A device whose previous session is still finishing its release cleanup (restores, recording
 * finalize) cannot be bound yet (#10960). Clients wait on it the way they wait for a held device.
 */
export const DEVICE_CLEANUP_IN_PROGRESS_CODE = "device_cleanup_in_progress";

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

/**
 * The session UUID is under a kill's terminal release reservation (#11146), so it cannot be bound,
 * rebound or reserved again. Unlike `device_shutting_down` it is NOT retryable: the UUID ends with
 * that release, so only a new session UUID (or nothing, for a second kill) can follow (#11189).
 */
export const SESSION_TERMINAL_RELEASE_IN_PROGRESS_CODE = "session_terminal_release_in_progress";

/**
 * A kill's terminal-release reservation named a device the session no longer holds (#11166).
 * Not retryable as-is: the device's holder changed, so the caller re-checks before killing.
 */
export const SESSION_NO_LONGER_OWNS_DEVICE_CODE = "session_no_longer_owns_device";

/**
 * A kill's terminal-release reservation raced the session's own rebind (#11166). Retryable with a
 * `retryAfterMs` hint once the rebind settles, but deliberately NOT in
 * {@link RETRYABLE_DEVICE_ACQUISITION_CODES}: it refuses a destructive shutdown, not an
 * acquisition, and after the rebind the device may be unowned or held by another session, so the
 * caller (not a client loop) decides whether to kill again (#11189).
 */
export const SESSION_REBINDING_CODE = "session_rebinding";

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
): ActionableError {
  if (holderAwaitingOwner) {
    return new ActionableError(
      `Device '${deviceId}' is reserved for session ${holderSessionId}, which the daemon restored ` +
        "after a restart and is holding for its previous owner to reconnect. If that session is " +
        `yours, pass sessionUuid ${holderSessionId} to reclaim it; otherwise wait for the ` +
        "reservation to lapse or use another device.",
    );
  }
  return new ActionableError(
    `Freshly started device '${deviceId}' was assigned to session ` +
      `${holderSessionId} before its owning session could reserve it.`,
  );
}

/** Retry hint when nothing bounds the remaining wait more precisely. */
export const DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS = 1_000;

/**
 * A typed, retryable refusal to bind a device that will become available without the caller
 * doing anything. The daemon does not block acquisition server-side; it returns this and the
 * client waits `retryAfterMs` before retrying, within its own bounded budget.
 */
export class RetryableDeviceAcquisitionError extends ActionableError {
  readonly retryable = true;

  constructor(
    readonly code: string,
    readonly deviceId: string,
    readonly retryAfterMs: number,
    message: string,
  ) {
    super(message);
    this.name = "RetryableDeviceAcquisitionError";
  }
}

export class DeviceCleanupInProgressError extends RetryableDeviceAcquisitionError {
  constructor(deviceId: string, retryAfterMs: number) {
    super(
      DEVICE_CLEANUP_IN_PROGRESS_CODE,
      deviceId,
      retryAfterMs,
      `Device '${deviceId}' is still completing the previous session's cleanup ` +
        `(code ${DEVICE_CLEANUP_IN_PROGRESS_CODE}); retry in about ${retryAfterMs}ms, ` +
        "after the cleanup finishes.",
    );
    this.name = "DeviceCleanupInProgressError";
  }
}

export class SessionCreationTimeoutError extends RetryableDeviceAcquisitionError {
  constructor(
    readonly sessionUuid: string,
    deviceId: string,
    timeoutMs: number,
  ) {
    super(
      SESSION_CREATION_TIMEOUT_CODE,
      deviceId,
      DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS,
      `Creating session ${sessionUuid} on device '${deviceId}' did not finish within ` +
        `${timeoutMs}ms (code ${SESSION_CREATION_TIMEOUT_CODE}); the device was not bound. ` +
        "Retry the request.",
    );
    this.name = "SessionCreationTimeoutError";
  }
}

/** Retry hint for a device another daemon holds: its claim lapses only once that session ends. */
export const DEVICE_OWNED_BY_OTHER_DAEMON_RETRY_AFTER_MS = 2_000;

export class DeviceOwnedByOtherDaemonError extends RetryableDeviceAcquisitionError {
  readonly ownerPid: number | undefined;

  /** @param remedy what the caller can do instead; defaults to the acquisition remedy */
  constructor(
    deviceId: string,
    ownerPid: number | undefined,
    remedy = "Retry after that daemon releases it, or pick another device.",
  ) {
    // A non-positive pid is the pool's "claimed, owner unreadable" marker, not a process.
    ownerPid = ownerPid !== undefined && ownerPid > 0 ? ownerPid : undefined;
    super(
      DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
      deviceId,
      DEVICE_OWNED_BY_OTHER_DAEMON_RETRY_AFTER_MS,
      `Device '${deviceId}' is claimed by another AutoMobile daemon` +
        (ownerPid === undefined ? "" : ` (PID ${ownerPid})`) +
        ` (code ${DEVICE_OWNED_BY_OTHER_DAEMON_CODE}); two daemons must never drive the same ` +
        `device. ${remedy}`,
    );
    this.ownerPid = ownerPid;
    this.name = "DeviceOwnedByOtherDaemonError";
  }
}

/** Retry hint for a device under shutdown: a kill normally finishes within a few seconds. */
export const DEVICE_SHUTTING_DOWN_RETRY_AFTER_MS = 2_000;

export class DeviceShuttingDownError extends RetryableDeviceAcquisitionError {
  /** @param detail what the refused step was trying to do, e.g. "and cannot be assigned" */
  constructor(deviceId: string, detail?: string) {
    super(
      DEVICE_SHUTTING_DOWN_CODE,
      deviceId,
      DEVICE_SHUTTING_DOWN_RETRY_AFTER_MS,
      `Device '${deviceId}' is shutting down${detail ? ` ${detail}` : ""} ` +
        `(code ${DEVICE_SHUTTING_DOWN_CODE}); retry once the shutdown has finished.`,
    );
    this.name = "DeviceShuttingDownError";
  }
}

/**
 * A session that was being created on demand was released before its creation returned (for
 * example an executePlan label session whose base was released mid-setup, #11146). The caller lost
 * the race; nothing is bound under its UUID.
 */
export const SESSION_RELEASED_DURING_CREATION_CODE = "session_released_during_creation";

export class SessionReleasedDuringCreationError extends ActionableError {
  readonly code = SESSION_RELEASED_DURING_CREATION_CODE;

  constructor(readonly sessionUuid: string) {
    super(
      `Session ${sessionUuid} was released while it was being created ` +
        `(code ${SESSION_RELEASED_DURING_CREATION_CODE}); no device is bound to it. ` +
        "Retry the request, or acquire a new device with getAndroid or getApple.",
    );
    this.name = "SessionReleasedDuringCreationError";
  }
}
