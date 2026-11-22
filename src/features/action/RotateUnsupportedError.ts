import { ActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  defaultAndroidXrDetector,
  type AndroidXrDetector,
} from "../../utils/android-cmdline-tools/androidXrDevice";
import {
  defaultWearOsDetector,
  type WearOsDetector,
} from "../../utils/android-cmdline-tools/wearOsDevice";

/** The rotate options that inject the shared XR and Wear OS predicates (tests pass fakes). */
export interface RotateXrOptions {
  xrDetector?: AndroidXrDetector;
  wearOsDetector?: WearOsDetector;
}

/**
 * `rotate` targeted a fixed-orientation Android display: an Android XR headset or glasses display
 * (#18909) or a Wear OS watch (#18959). Neither honours `user_rotation`, so rotate refuses before
 * writing any rotation setting instead of waiting out the rotation settle timeout. Typed so callers
 * can tell an unsupported target from a rotation that failed to settle.
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

/** The refusal for a Wear OS watch; no rotation setting has been written. */
export function wearOsRotateUnsupportedError(deviceId: string): RotateUnsupportedError {
  return new RotateUnsupportedError(
    `rotate is not supported on Wear OS watch ${deviceId}: its display has a fixed orientation ` +
      "and ignores user_rotation, so no rotation setting was changed. Use a phone, tablet or " +
      "foldable device to test orientation changes.",
  );
}

/**
 * Throw {@link RotateUnsupportedError} when the shared XR predicate says the device is Android XR,
 * or the Wear OS predicate says it is a watch, before any rotation setting is written or a
 * rotation wait starts.
 */
export async function refuseRotateOnFixedOrientationDevice(
  device: BootedDevice,
  adb: AdbCommandRunner,
  {
    xrDetector = defaultAndroidXrDetector,
    wearOsDetector = defaultWearOsDetector,
  }: RotateXrOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  const xr = await xrDetector.isAndroidXr({ device, adb, signal });
  signal?.throwIfAborted();
  if (xr) {
    throw androidXrRotateUnsupportedError(device.deviceId);
  }
  const watch = await wearOsDetector.isWearOs({ device, adb, signal });
  signal?.throwIfAborted();
  if (watch) {
    throw wearOsRotateUnsupportedError(device.deviceId);
  }
}
