export {
  IOS_FOREGROUND_RESTORE_MAX_MS,
  SimctlIosForegroundRestorer,
  type IosForegroundRestorer,
} from "../../utils/ios-cmdline-tools/IosForegroundRestorer";
import type { BootedDevice, ObserveResult } from "../../models";
import { usableForegroundAppId } from "../observe/observationVerdict";

const SPRINGBOARD_BUNDLE_ID = "com.apple.springboard";

/** True for an app the restore can bring back: a named app other than SpringBoard. */
export function isRestorableIosApp(appId: string | undefined): appId is string {
  return !!appId && appId !== SPRINGBOARD_BUNDLE_ID;
}

/**
 * The app that was in front when an iOS device was locked with `pressButton power` (#19231).
 * The lock screen hides it from observation, so `wakeAndUnlock` reads it here to bring the app
 * back after the unlock goes through SpringBoard. Keyed by device id.
 */
export class IosPreLockForegroundRegistry {
  private readonly apps = new Map<string, string>();

  /** Records the app in front before a lock; SpringBoard or an unknown app clears the entry. */
  record(deviceId: string, appId: string | undefined): void {
    if (isRestorableIosApp(appId)) {
      this.apps.set(deviceId, appId);
    } else {
      this.apps.delete(deviceId);
    }
  }

  /** Returns and clears the recorded app, so one lock restores at most once. */
  take(deviceId: string): string | undefined {
    const appId = this.apps.get(deviceId);
    this.apps.delete(deviceId);
    return appId;
  }
}

export const iosPreLockForeground = new IosPreLockForegroundRegistry();

/**
 * After a plain iOS `power` press, record the app the pre-press observation showed in front. A
 * pre-press read of a locked device leaves the record alone: that press woke the lock screen and
 * the app behind it is still the one recorded when it locked.
 */
export function recordIosAppBeforePowerPress(
  press: {
    device: BootedDevice;
    button: string;
    pressSucceeded: boolean;
    durationMs?: number;
    prePress?: ObserveResult;
  },
  registry: IosPreLockForegroundRegistry = iosPreLockForeground,
): void {
  const { device, button, pressSucceeded, durationMs, prePress } = press;
  if (
    device.platform !== "ios" ||
    button.toLowerCase() !== "power" ||
    !pressSucceeded ||
    durationMs !== undefined ||
    !prePress ||
    prePress.deviceLock?.locked === true
  ) {
    return;
  }
  registry.record(device.deviceId, usableForegroundAppId(prePress));
}
