import {
  SESSION_CREATION_TIMEOUT_CODE,
  DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS,
} from "./deviceAcquisitionRefusals";
import { RetryableDeviceAcquisitionError } from "./RetryableDeviceAcquisitionError";

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
