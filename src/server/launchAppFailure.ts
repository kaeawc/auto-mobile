import { ActionableError, toActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import { isDeviceLostError } from "../models/DeviceLostError";
import { iosMutationTokens } from "../features/storage/IosMutationTokens";
import { findDeviceTransportUnavailable } from "../utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";

export function redactLaunchMessage(message: string, token: string | undefined): string {
  return token ? message.split(token).join("[REDACTED]") : message;
}

function redactLaunchError(error: unknown, token: string | undefined): unknown {
  return token && String(error).includes(token)
    ? new Error(redactLaunchMessage(String(error), token))
    : error;
}

/** Clears the launch's mutation token and returns the error to throw, token redacted. */
export function launchFailure(
  error: unknown,
  device: BootedDevice,
  appId: string,
  mutationToken: string | undefined,
): unknown {
  if (mutationToken) {
    iosMutationTokens.clear(device.deviceId, appId, mutationToken);
  }
  const transport = findDeviceTransportUnavailable(error);
  if (transport) {
    return transport;
  }
  const safeError = redactLaunchError(error, mutationToken);
  // A typed launch failure (uninstalled package, foreground mismatch) is
  // already an actionable error — surface it verbatim rather than re-wrapping
  // it as "Failed to launch app: Error: ..." (#5868).
  if (isDeviceLostError(error) || safeError instanceof ActionableError) {
    return safeError;
  }
  return toActionableError(safeError, `Failed to launch app`);
}
