import { ActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  defaultWearOsDetector,
  type WearOsDetector,
} from "../../utils/android-cmdline-tools/wearOsDevice";
import {
  defaultAndroidTvDetector,
  type AndroidTvDetector,
} from "../../utils/android-cmdline-tools/androidTvDevice";

/** The form-factor predicates `recentApps` asks before it presses anything (tests pass fakes). */
export interface RecentAppsFormFactorOptions {
  wearOsDetector?: WearOsDetector;
  tvDetector?: AndroidTvDetector;
}

/**
 * `recentApps` targeted an Android device with no launcher recents overview to verify: a Wear OS
 * watch or an Android TV (#19180). Refused before any press, instead of pressing Recents and
 * failing after the verification window. Typed so callers can tell an unsupported target from an
 * overview that did not open.
 */
export class RecentAppsUnsupportedError extends ActionableError {}

function refusal(deviceId: string, formFactor: string): RecentAppsUnsupportedError {
  return new RecentAppsUnsupportedError(
    `recentApps is not supported on ${formFactor} ${deviceId}: it has no recent apps overview ` +
      "to open and verify, so nothing was pressed. Use launchApp to switch apps, or pressButton " +
      "home to leave the current one.",
  );
}

/**
 * Throw {@link RecentAppsUnsupportedError} when the Wear OS predicate says the device is a watch,
 * or the Android TV predicate says it is a TV, before any key or global action is sent.
 */
export async function refuseRecentAppsWithoutOverview(
  device: BootedDevice,
  adb: AdbCommandRunner,
  {
    wearOsDetector = defaultWearOsDetector,
    tvDetector = defaultAndroidTvDetector,
  }: RecentAppsFormFactorOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  const watch = await wearOsDetector.isWearOs({ device, adb, signal });
  signal?.throwIfAborted();
  if (watch) {
    throw refusal(device.deviceId, "Wear OS watch");
  }
  const tv = await tvDetector.isAndroidTv({ device, adb, signal });
  signal?.throwIfAborted();
  if (tv) {
    throw refusal(device.deviceId, "Android TV");
  }
}
