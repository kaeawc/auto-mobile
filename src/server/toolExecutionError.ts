import { ActionableError, toActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import { isDeviceLostError } from "../models/DeviceLostError";
import { rethrowDeviceTransportUnavailable } from "../utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";

/** Preserve typed device failures before adding tool context to ordinary errors. */
export function toolExecutionError(
  error: unknown,
  name: string,
  device: BootedDevice | undefined,
): Error {
  rethrowDeviceTransportUnavailable(error);
  if (error instanceof ActionableError || isDeviceLostError(error)) {
    return error;
  }
  const deviceContext = device ? ` on device ${device.deviceId}` : "";
  return toActionableError(error, `Failed to execute tool ${name}${deviceContext}`);
}
