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

/** Wire codes of acquisition refusals a client should wait out rather than fail on. */
export const RETRYABLE_DEVICE_ACQUISITION_CODES: ReadonlySet<string> = new Set([
  DEVICE_CLEANUP_IN_PROGRESS_CODE,
  SESSION_CREATION_TIMEOUT_CODE,
  DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
]);

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
  constructor(
    deviceId: string,
    readonly ownerPid: number | undefined,
  ) {
    super(
      DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
      deviceId,
      DEVICE_OWNED_BY_OTHER_DAEMON_RETRY_AFTER_MS,
      `Device '${deviceId}' is claimed by another AutoMobile daemon` +
        (ownerPid === undefined ? "" : ` (PID ${ownerPid})`) +
        ` (code ${DEVICE_OWNED_BY_OTHER_DAEMON_CODE}); two daemons must never drive the same ` +
        "device. Retry after that daemon releases it, or pick another device.",
    );
    this.name = "DeviceOwnedByOtherDaemonError";
  }
}
