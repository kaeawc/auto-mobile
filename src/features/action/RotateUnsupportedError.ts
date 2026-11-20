import { ActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  defaultAndroidXrDetector,
  type AndroidXrDetector,
} from "../../utils/android-cmdline-tools/androidXrDevice";

export type { AndroidXrDetector };

/**
 * `rotate` targeted an Android XR headset or glasses display (#18909). The XR display runs apps
 * as freeform panels and ignores `user_rotation`, so rotate refuses before writing any rotation
 * setting instead of waiting out the rotation settle timeout. Typed so callers can tell an
 * unsupported target from a rotation that failed to settle.
 */
export class RotateUnsupportedError extends ActionableError {}

/** The refusal for an Android XR device; no rotation setting has been written. */
export function androidXrRotateUnsupportedError(deviceId: string): RotateUnsupportedError {
  return new RotateUnsupportedError(
    `rotate is not supported on Android XR device ${deviceId}: its display runs apps as freeform ` +
      "panels and ignores user_rotation, so no rotation setting was changed. Use a phone, " +
      "tablet or foldable device to test orientation changes.",
  );
}

/**
 * Throw {@link RotateUnsupportedError} when the shared XR predicate says the device is Android XR,
 * before any rotation setting is written or a rotation wait starts.
 */
export async function refuseRotateOnAndroidXr(
  device: BootedDevice,
  adb: AdbCommandRunner,
  detector: AndroidXrDetector = defaultAndroidXrDetector,
  signal?: AbortSignal,
): Promise<void> {
  const xr = await detector.isAndroidXr({ device, adb, signal });
  signal?.throwIfAborted();
  if (xr) {
    throw androidXrRotateUnsupportedError(device.deviceId);
  }
}
