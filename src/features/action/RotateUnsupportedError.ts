import { ActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  defaultAndroidXrDetector,
  type AndroidXrDetector,
} from "../../utils/android-cmdline-tools/androidXrDevice";
import {
  defaultXrGlassesDetector,
  type XrGlassesDetector,
} from "../../utils/android-cmdline-tools/xrGlassesDevice";
import {
  defaultWearOsDetector,
  type WearOsDetector,
} from "../../utils/android-cmdline-tools/wearOsDevice";
import {
  defaultAndroidTvDetector,
  type AndroidTvDetector,
} from "../../utils/android-cmdline-tools/androidTvDevice";

/** The rotate options that inject the shared XR, Wear OS and Android TV predicates (tests pass fakes). */
export interface RotateXrOptions {
  xrDetector?: AndroidXrDetector;
  /** AI glasses declare no spatial XR feature, so they are asked about separately (#19196). */
  glassesDetector?: XrGlassesDetector;
  wearOsDetector?: WearOsDetector;
  tvDetector?: AndroidTvDetector;
}

/**
 * `rotate` targeted a fixed-orientation Android display: an Android XR headset or glasses display
 * (#18909), a Wear OS watch (#18959) or an Android TV (#19178). None of them is meant to honour `user_rotation`, so rotate refuses before
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
 * The refusal for an Android TV; no rotation setting has been written. TV images do apply
 * `user_rotation`, which turns the landscape-only TV UI into a portrait display that stays rotated.
 */
export function androidTvRotateUnsupportedError(deviceId: string): RotateUnsupportedError {
  return new RotateUnsupportedError(
    `rotate is not supported on Android TV ${deviceId}: a TV display has a fixed landscape ` +
      "orientation, so no rotation setting was changed. Use a phone, tablet or foldable device " +
      "to test orientation changes.",
  );
}

/**
 * Throw {@link RotateUnsupportedError} when the shared XR predicate says the device is Android XR,
 * the glasses predicate says it is Android XR glasses, the Wear OS predicate says it is a watch, or the Android TV predicate says it is a TV, before any rotation setting is written or a
 * rotation wait starts.
 */
export async function refuseRotateOnFixedOrientationDevice(
  device: BootedDevice,
  adb: AdbCommandRunner,
  {
    xrDetector = defaultAndroidXrDetector,
    glassesDetector = defaultXrGlassesDetector,
    wearOsDetector = defaultWearOsDetector,
    tvDetector = defaultAndroidTvDetector,
  }: RotateXrOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  const evidence = { device, adb, signal };
  const checks: Array<[() => Promise<boolean>, (deviceId: string) => RotateUnsupportedError]> = [
    [() => xrDetector.isAndroidXr(evidence), androidXrRotateUnsupportedError],
    [() => glassesDetector.isXrGlasses(evidence), androidXrRotateUnsupportedError],
    [() => wearOsDetector.isWearOs(evidence), wearOsRotateUnsupportedError],
    [() => tvDetector.isAndroidTv(evidence), androidTvRotateUnsupportedError],
  ];
  // Asked in order, so an earlier refusal never pays for a later probe.
  for (const [unsupported, refusal] of checks) {
    const refuse = await unsupported();
    signal?.throwIfAborted();
    if (refuse) {
      throw refusal(device.deviceId);
    }
  }
}
