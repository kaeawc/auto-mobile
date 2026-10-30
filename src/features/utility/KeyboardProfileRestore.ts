import type { BootedDevice } from "../../models";
import { withAndroidImeLock } from "../action/androidImeLock";
import { setKeyboardProfile } from "../action/setKeyboardProfile";
import type { KeyboardProfileId } from "../action/keyboardProfiles";
import type { AndroidCtrlProxy } from "../observe/android";
import { androidCtrlProxyClientFor } from "../observe/android/androidCtrlProxyClientFor";
import { runOutsideRequestContext } from "../../utils/AbortContext";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";

/** Bound on the best-effort keyboard-profile restore run at session release. */
export const KEYBOARD_PROFILE_RESTORE_TIMEOUT_MS = 5_000;

/** The CtrlProxy surface a keyboard-profile restore needs. */
export type KeyboardProfileClient = Pick<AndroidCtrlProxy, "setKeyboardProfile">;

export type KeyboardProfileClientFactory = (device: BootedDevice) => KeyboardProfileClient;

export const defaultKeyboardProfileClientFactory: KeyboardProfileClientFactory =
  androidCtrlProxyClientFor;

interface KeyboardProfileRestoreEntry {
  device: BootedDevice;
  /** The session whose release restores the entry; undefined while only sessionless calls wrote. */
  owner?: string;
  /** The profile active before the first keyboard-profile change. */
  profileId: string;
}

export interface OwnedKeyboardProfileRestore {
  device: BootedDevice;
  profileId: string;
}

/**
 * Per-device, write-once record of the AutoMobile IME's keyboard behaviour
 * profile before `keyboard setProfile` or a persona's keyboard facet first
 * changed it (#14705), so a second change never overwrites the original with
 * the profile the first one set. CtrlProxy persists the active profile, so
 * without this record a session's profile outlived it. In memory only: a
 * daemon restart loses it.
 *
 * A session that changes the profile takes ownership of the device's entry, so
 * its release restores the profile recorded there, including one a sessionless
 * call changed first. An entry only sessionless calls wrote stays until a
 * persona reset.
 */
export class KeyboardProfileRestoreRegistry {
  private readonly entries = new Map<string, KeyboardProfileRestoreEntry>();

  /** Record `profileBefore` unless a profile is already recorded. Returns true when this call recorded it. */
  record(device: BootedDevice, profileBefore: string, owner: string | undefined): boolean {
    const existing = this.entries.get(device.deviceId);
    const entry: KeyboardProfileRestoreEntry = existing ?? { device, profileId: profileBefore };
    this.entries.set(device.deviceId, entry);
    entry.device = device;
    if (owner !== undefined) {
      entry.owner = owner;
    }
    return existing === undefined;
  }

  /** The profile reset restores; undefined when no change is recorded. */
  pending(deviceId: string): string | undefined {
    return this.entries.get(deviceId)?.profileId;
  }

  /** The recorded profile was put back. */
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
    return { device: entry.device, profileId: entry.profileId };
  }

  /** The device is gone (or its serial now names another device): nothing left to restore. */
  retireDevice(deviceId: string): void {
    this.entries.delete(deviceId);
  }
}

export const defaultKeyboardProfileRestoreRegistry = new KeyboardProfileRestoreRegistry();

/**
 * Set the profile a released session left back, bounded and outside the
 * releasing request's abort context (cleanup must outlive the call that
 * triggered it), under the device's shared IME lock. A restore that times out
 * gives up waiting for the lock, so it cannot land on the device's next owner.
 * Best effort: a failure is logged. Resolves with whether the profile was restored.
 */
export async function restoreOwnedKeyboardProfile(
  owned: OwnedKeyboardProfileRestore,
  clientFor: KeyboardProfileClientFactory,
  timer: Pick<Timer, "setTimeout" | "clearTimeout">,
): Promise<boolean> {
  const abandoned = new AbortController();
  try {
    const client = clientFor(owned.device);
    await runOutsideRequestContext(() =>
      raceWithDeadline(
        () =>
          withAndroidImeLock(
            owned.device.deviceId,
            async () => {
              const result = await client.setKeyboardProfile(
                owned.profileId,
                KEYBOARD_PROFILE_RESTORE_TIMEOUT_MS,
              );
              if (!result.success) {
                throw new Error(result.error ?? "CtrlProxy refused the keyboard profile");
              }
            },
            abandoned.signal,
          ),
        {
          timer,
          timeoutMs: KEYBOARD_PROFILE_RESTORE_TIMEOUT_MS,
          label: `Restore keyboard profile ${owned.profileId}`,
          onTimeout: () => abandoned.abort(),
        },
      ),
    );
    return true;
  } catch (error) {
    logger.warn(
      `Failed to restore keyboard profile ${owned.profileId} on ${owned.device.deviceId}: ${errorMessage(error)}`,
      error,
    );
    return false;
  }
}

type KeyboardProfileWriteClient = Pick<AndroidCtrlProxy, "supportsCommand" | "setKeyboardProfile">;

/**
 * Write `profile` and record the profile active before the first change (#14705), inside the
 * device's IME lock, so the owning session's release or a persona reset can put it back.
 */
export function setKeyboardProfileRecorded(
  device: BootedDevice,
  profile: KeyboardProfileId,
  client: KeyboardProfileWriteClient | undefined,
  signal: AbortSignal | undefined,
  record: { owner?: string; registry?: KeyboardProfileRestoreRegistry } = {},
): Promise<{ activeProfileId?: string; previousProfileId?: string }> {
  const registry = record.registry ?? defaultKeyboardProfileRestoreRegistry;
  return setKeyboardProfile(device, profile, {
    client,
    signal,
    onWritten: (previousProfileId) => {
      if (previousProfileId !== undefined) {
        registry.record(device, previousProfileId, record.owner);
      }
    },
  });
}

/**
 * Put back the keyboard profile recorded before the first change and forget it. With nothing
 * recorded it changes nothing; a refused write stays recorded, so a later reset or the owning
 * session's release retries it.
 */
export async function resetKeyboardProfileFromRecord(
  device: BootedDevice,
  client: KeyboardProfileWriteClient | undefined,
  signal: AbortSignal | undefined,
  registry: KeyboardProfileRestoreRegistry = defaultKeyboardProfileRestoreRegistry,
): Promise<{ restoredProfileId?: string }> {
  const profile = registry.pending(device.deviceId);
  if (profile === undefined) {
    return {};
  }
  await setKeyboardProfile(device, profile, {
    client,
    signal,
    onWritten: () => registry.forget(device.deviceId),
  });
  return { restoredProfileId: profile };
}
