import { RetryableDeviceAcquisitionError } from "./RetryableDeviceAcquisitionError";

/**
 * The device is under a kill/shutdown reservation, so an acquisition or readiness step cannot
 * proceed. The reservation clears once the shutdown finishes (or fails), after which the device
 * can be acquired again, so clients wait on it like a held device.
 */
export const DEVICE_SHUTTING_DOWN_CODE = "device_shutting_down";

/**
 * Retry hint for a device under shutdown: a kill normally finishes within a few seconds. It is a
 * polling interval, not a remaining time like `device_cleanup_in_progress` carries (#11616): a
 * shutdown reservation spans several separately bounded steps and records no deadline, so the
 * refusal has no bound to report. Each usable hint extends the runners' total wait using
 * max(30 s, min(waited + retryAfterMs, 150 s)), up to the 150 s cap. The 30 s floor alone
 * applies only when the refusal carries no usable hint.
 */
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
