import {
  RetryableDeviceAcquisitionError,
  DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS,
} from "./RetryableDeviceAcquisitionError";

/**
 * A session's creation did not finish within its deadline (a wedged DB write or a release of the
 * same UUID that never settled), so the bind was rolled back rather than hold the device and the
 * pool's assignment mutex (#10963). Retrying is safe.
 */
export const SESSION_CREATION_TIMEOUT_CODE = "session_creation_timeout";

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
