import {
  RetryableDeviceAcquisitionError,
  DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS,
} from "./RetryableDeviceAcquisitionError";

/** adb still lists the transport, but it has not returned online within the bind budget. */
export const DEVICE_OFFLINE_CODE = "device_offline";

export class DeviceTransportOfflineError extends RetryableDeviceAcquisitionError {
  constructor(
    deviceId: string,
    readonly state: string | undefined,
    adoptedRuntime = false,
  ) {
    super(
      DEVICE_OFFLINE_CODE,
      deviceId,
      DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS,
      (state === undefined
        ? adoptedRuntime
          ? `adb did not list the previously resolved emulator '${deviceId}' steadily while binding (its transport was absent or flapping) `
          : `The emulator process this request started for device '${deviceId}' is still running but adb does not list its transport yet `
        : `Device '${deviceId}' is still attached but adb lists it as ${state} `) +
        `(code ${DEVICE_OFFLINE_CODE}); it was not bound. Retry in about ` +
        `${DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS}ms.`,
    );
    this.name = "DeviceTransportOfflineError";
  }
}
