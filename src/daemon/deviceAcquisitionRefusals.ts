import { ActionableError } from "../models/ActionableError";

/**
 * A device whose previous session is still finishing its release cleanup (restores, recording
 * finalize) cannot be bound yet (#10960). Clients wait on it the way they wait for a held device.
 */
export const DEVICE_CLEANUP_IN_PROGRESS_CODE = "device_cleanup_in_progress";

/** Wire codes of acquisition refusals a client should wait out rather than fail on. */
export const RETRYABLE_DEVICE_ACQUISITION_CODES: ReadonlySet<string> = new Set([
  DEVICE_CLEANUP_IN_PROGRESS_CODE,
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
