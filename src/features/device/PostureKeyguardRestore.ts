import type { BootedDevice } from "../../models";
import type { DeviceLockState } from "../../models/DeviceLockState";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidWakeAndUnlock } from "../../utils/android-cmdline-tools/AndroidWakeAndUnlock";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";

/** The one AndroidWakeAndUnlock call a posture change needs: dismiss a swipe keyguard. */
export type PostureKeyguardDismisser = Pick<AndroidWakeAndUnlock, "execute">;

export type PostureKeyguardDismisserFactory = (
  device: BootedDevice,
  adb: AdbExecutor,
  timer: Timer,
) => PostureKeyguardDismisser;

export const defaultPostureKeyguardDismisserFactory: PostureKeyguardDismisserFactory = (
  device,
  adb,
  timer,
) => new AndroidWakeAndUnlock(device, adb, { timer });

export type PostureKeyguardRestoreOutcome =
  | { kind: "unchanged" }
  | { kind: "dismissed" }
  | { kind: "failed"; warning: string };

/**
 * Reads the lock state before a posture change. Null (unknown) disables the restore, so an
 * unreadable device is never unlocked on a guess.
 */
export async function readLockBeforePostureChange(
  adb: AdbExecutor,
  signal?: AbortSignal,
): Promise<DeviceLockState | null> {
  throwIfAborted(signal);
  return awaitWhileRequestIsLive(adb.getDeviceLock(signal), signal);
}

/**
 * Folding a Pixel Fold raises the "Swipe up to continue" keyguard even without a lock
 * credential, and reopening keeps it up, so a posture change alone would leave automation blocked.
 * Dismiss it only when the device was unlocked before the change and the keyguard now showing is
 * definitely not secure. A secure or unreadable lock is left for wakeAndUnlock.
 */
export async function restoreSwipeKeyguardAfterPostureChange(options: {
  before: DeviceLockState | null;
  lockedAfter: boolean | undefined;
  adb: AdbExecutor;
  dismisser: PostureKeyguardDismisser;
  signal?: AbortSignal;
}): Promise<PostureKeyguardRestoreOutcome> {
  const { before, lockedAfter, adb, dismisser, signal } = options;
  if (!before || before.keyguardShowing || lockedAfter !== true) {
    return { kind: "unchanged" };
  }
  throwIfAborted(signal);
  const after = await awaitWhileRequestIsLive(adb.getDeviceLock(signal), signal);
  if (!after?.keyguardShowing || after.secure !== false) {
    return { kind: "unchanged" };
  }
  try {
    const unlock = await awaitWhileRequestIsLive(dismisser.execute(undefined, signal), signal);
    if (unlock.success) {
      return { kind: "dismissed" };
    }
    logger.warn(
      `[SetPosture] swipe keyguard raised by the posture change stayed up: ${unlock.error}`,
    );
    return {
      kind: "failed",
      warning: `The posture change raised the swipe keyguard and dismissing it failed (${unlock.error ?? "unknown error"}). Call wakeAndUnlock before acting.`,
    };
  } catch (error) {
    throwIfAborted(signal);
    logger.warn(
      `[SetPosture] dismissing the posture-change keyguard failed: ${errorMessage(error)}`,
      error,
    );
    return {
      kind: "failed",
      warning: `The posture change raised the swipe keyguard and dismissing it failed (${errorMessage(error)}). Call wakeAndUnlock before acting.`,
    };
  }
}
