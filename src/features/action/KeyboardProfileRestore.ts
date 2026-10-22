import type { BootedDevice } from "../../models";
import { runOutsideRequestContext } from "../../utils/AbortContext";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import { setKeyboardProfileForTool } from "./keyboardProfileControl";
import { KEYBOARD_PROFILE_IDS, type KeyboardProfileId } from "./keyboardProfiles";

/** Bound on the best-effort keyboard profile restore run at session release. */
export const KEYBOARD_PROFILE_RESTORE_TIMEOUT_MS = 5_000;

/** Sets a keyboard behaviour profile on a device; `setKeyboardProfileForTool` in production. */
export type KeyboardProfileSetter = (
  device: BootedDevice,
  profile: KeyboardProfileId,
  signal?: AbortSignal,
) => Promise<unknown>;

export const defaultKeyboardProfileSetter: KeyboardProfileSetter = (device, profile, signal) =>
  setKeyboardProfileForTool(device, profile, undefined, signal);

export function isKeyboardProfileId(value: string): value is KeyboardProfileId {
  return (KEYBOARD_PROFILE_IDS as readonly string[]).includes(value);
}

interface KeyboardProfileRestoreEntry {
  device: BootedDevice;
  /** The profile active before the first recorded change. */
  before: KeyboardProfileId;
  /** The session whose release restores it; undefined while only sessionless calls wrote. */
  owner?: string;
}

export interface OwnedKeyboardProfileRestore {
  device: BootedDevice;
  before: KeyboardProfileId;
}

/**
 * Per-device, write-once record of the AutoMobile IME keyboard behaviour
 * profile active before `keyboard setProfile` or a persona first changed it
 * (#14705). CtrlProxy persists the active profile, so without this a session's
 * profile stays active for the device's next session. A session that changes
 * the profile owns the entry and its release restores the profile from before
 * its first change; a session taking over a sessionless entry records its own
 * before-profile, so sessionless changes persist. An entry only sessionless
 * calls wrote stays until a persona reset or the device is retired. In memory
 * only: a daemon restart loses it.
 */
export class KeyboardProfileRestoreRegistry {
  private readonly entries = new Map<string, KeyboardProfileRestoreEntry>();

  /** Record the profile before a change unless one is recorded already. */
  record(device: BootedDevice, before: string | undefined, owner: string | undefined): void {
    const existing = this.entries.get(device.deviceId);
    const known = before !== undefined && isKeyboardProfileId(before) ? before : undefined;
    if (existing && !(existing.owner === undefined && owner !== undefined && known)) {
      // Keep the owner: a session must not take over a sessionless entry without its own
      // before-profile, or its release would undo the sessionless change.
      existing.device = device;
      return;
    }
    // A session taking over a sessionless entry records its own before-profile, so its
    // release keeps the sessionless change instead of undoing it.
    if (known === undefined) {
      logger.warn(
        `Keyboard profile before the change on ${device.deviceId} is unknown ('${before}'); it will not be restored.`,
      );
      return;
    }
    this.entries.set(device.deviceId, { device, before: known, ...(owner ? { owner } : {}) });
  }

  /** The profile recorded before the first change, if one is waiting to be restored. */
  recorded(deviceId: string): KeyboardProfileId | undefined {
    return this.entries.get(deviceId)?.before;
  }

  /** The profile `sessionId`'s release will restore on `deviceId`, if it owns the entry. */
  ownedRestoreTarget(deviceId: string, sessionId: string): KeyboardProfileId | undefined {
    const entry = this.entries.get(deviceId);
    return entry?.owner === sessionId ? entry.before : undefined;
  }

  /** Whether a session release will restore this device's recorded profile. */
  restoresOnRelease(deviceId: string): boolean {
    return this.entries.get(deviceId)?.owner !== undefined;
  }

  /** The recorded profile was restored. */
  forget(deviceId: string): void {
    this.entries.delete(deviceId);
  }

  /** Remove and return the entry `sessionId` owns on `deviceId`, for its release to restore. */
  takeOwnedBy(deviceId: string, sessionId: string): OwnedKeyboardProfileRestore | undefined {
    const entry = this.entries.get(deviceId);
    if (entry?.owner !== sessionId) {
      return undefined;
    }
    this.entries.delete(deviceId);
    return { device: entry.device, before: entry.before };
  }

  /** The device is gone (or its serial now names another device): nothing left to restore. */
  retireDevice(deviceId: string): void {
    this.entries.delete(deviceId);
  }
}

export const defaultKeyboardProfileRestoreRegistry = new KeyboardProfileRestoreRegistry();

/**
 * Put the keyboard profile a released session changed back, bounded and outside
 * the releasing request's abort context. Best effort: a failure is logged and
 * resolves false so release is never blocked on it.
 */
export async function restoreKeyboardProfileAfterRelease(
  owned: OwnedKeyboardProfileRestore,
  setProfile: KeyboardProfileSetter,
  timer: Pick<Timer, "setTimeout" | "clearTimeout">,
): Promise<boolean> {
  // Aborted on the deadline so a restore stuck before the IME lock cannot land after the
  // device's next owner set its own profile.
  const controller = new AbortController();
  try {
    await runOutsideRequestContext(() =>
      raceWithDeadline(() => setProfile(owned.device, owned.before, controller.signal), {
        timer,
        timeoutMs: KEYBOARD_PROFILE_RESTORE_TIMEOUT_MS,
        label: `Restore keyboard profile ${owned.before}`,
      }),
    );
    return true;
  } catch (error) {
    controller.abort();
    logger.warn(
      `Failed to restore keyboard profile ${owned.before} on ${owned.device.deviceId}: ${errorMessage(error)}`,
      error,
    );
    return false;
  }
}
