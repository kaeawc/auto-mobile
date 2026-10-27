/**
 * Shared types, constants and the collaborator context for Rotate and the helpers split out of
 * it (RotationSettingsStore, RotationOrientationReader, RotationOutcomes) for max-class-lines.
 */

import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { BootedDevice } from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import type { AwaitIdle } from "../observe/interfaces/AwaitIdle";

export interface RotationRestoreState {
  accelerometerRotation: 0 | 1 | null;
  userRotation: number | null;
  /**
   * Original `secure device_state_rotation_lock` (per-device-state lock map on foldables and
   * resizable emulators), captured before the session's first rotation write. Turning
   * auto-rotate off rewrites this map, and while it records a lock the window manager reverts
   * `accelerometer_rotation=1`, so restore writes it back first. Absent when the device has no
   * such setting.
   */
  deviceStateRotationLock?: string;
}

export const DEVICE_STATE_ROTATION_LOCK = "device_state_rotation_lock";
// Values of a `device_state_rotation_lock` entry (Settings.Secure.DEVICE_STATE_ROTATION_LOCK_*).
const DEVICE_STATE_ROTATION_LOCKED = "1";
const DEVICE_STATE_ROTATION_UNLOCKED = "2";

/**
 * Unlock `deviceState`'s entry in a `device_state_rotation_lock` map
 * (`state:setting:state:setting...`). Returns null when the map is malformed or the entry is
 * not locked, so there is nothing to write.
 */
export function unlockDeviceStateRotationEntry(map: string, deviceState: number): string | null {
  const parts = map.split(":");
  if (parts.length < 2 || parts.length % 2 !== 0) {
    return null;
  }
  const index = parts.findIndex((part, i) => i % 2 === 0 && part === String(deviceState));
  if (index < 0 || parts[index + 1] !== DEVICE_STATE_ROTATION_LOCKED) {
    return null;
  }
  parts[index + 1] = DEVICE_STATE_ROTATION_UNLOCKED;
  return parts.join(":");
}

export interface RotationRestoreSlot {
  get(): RotationRestoreState | undefined;
  record(state: RotationRestoreState): void;
  clear(): void;
}

export type RotationSettingKey = "user_rotation" | "accelerometer_rotation";

export interface RotationCallSettings {
  previousUserRotation: number | null;
  started: boolean;
  writtenUserRotation: number | null;
  beforeWrite(options?: {
    accelerometerRotation?: boolean;
    captureUserRotation?: boolean;
    userRotation?: number;
  }): Promise<void>;
}

export interface RotationSettingCleanup {
  assertCurrentDevice?: () => void;
  pendingWrite?: Promise<unknown>;
  needed: boolean;
  /**
   * How turning auto-rotate back on handles `secure device_state_rotation_lock` (mt-0083 D1):
   * while that per-state map records a lock for the current device state, the window manager
   * reverts an `accelerometer_rotation=1` write to 0. "restore" writes back the map captured
   * before this call forced auto-rotate off; "clear" unlocks the committed device state's entry
   * (auto-rotate was not on before the call). Unset leaves the map alone.
   */
  deviceStateLock?: { kind: "restore"; value: string } | { kind: "clear" };
}

export const ROTATION_SETTING_CLEANUP_TIMEOUT_MS = 1000;
export const ROTATION_RETURN_CONFIRMATION_TIMEOUT_MS = 1000;

/**
 * Live view of the Rotate instance's collaborators. Read through a provider so every helper
 * sees the same lazily-resolved adb executor, timer and idle tracker as Rotate itself.
 */
export interface RotationContext {
  device: BootedDevice;
  adb: AdbExecutor;
  timer: Timer;
  awaitIdle: AwaitIdle;
  deadlineMs: number | undefined;
}
