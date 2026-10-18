import {
  DEVICE_SHUTTING_DOWN_CODE,
  DEVICE_SHUTTING_DOWN_RETRY_AFTER_MS,
} from "./deviceAcquisitionRefusals";
import { RetryableDeviceAcquisitionError } from "./RetryableDeviceAcquisitionError";

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
