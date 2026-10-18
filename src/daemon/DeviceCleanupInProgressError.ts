import { DEVICE_CLEANUP_IN_PROGRESS_CODE } from "./deviceAcquisitionRefusals";
import { RetryableDeviceAcquisitionError } from "./RetryableDeviceAcquisitionError";

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
