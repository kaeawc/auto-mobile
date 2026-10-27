import type { BootedDevice } from "../../models";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { ApiLevelProbeExecutor } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { outputLooksLikeShellFailure } from "../../utils/android-cmdline-tools/shellOutputHeuristics";
import { runOutsideRequestContext } from "../../utils/AbortContext";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";

/** Bound on each best-effort restore command run at session release. */
export const KILL_PROFILE_RESTORE_TIMEOUT_MS = 2_000;

/** The adb surface kill profiles need. */
export type KillProfileShell = ApiLevelProbeExecutor;

export type KillProfileShellFactory = (device: BootedDevice) => KillProfileShell;

export const defaultKillProfileShellFactory: KillProfileShellFactory = (device) =>
  defaultAdbClientFactory.create(device);

/** How to put one facet back the way it was before the first kill-profile change. */
export interface KillProfileRestoreAction {
  /** `battery`, `deviceIdle`, `standbyBucket:<pkg>` or `appOp:<op>:<pkg>`. */
  key: string;
  /** The package the facet belongs to; undefined for device-wide battery and Doze state. */
  appId?: string;
  /**
   * The adb command that restores the facet, or null when the facet was already in the
   * applied state before the first change (for example a battery already unplugged by hand).
   */
  command: string | null;
}

interface KillProfileRestoreEntry {
  device: BootedDevice;
  /** The session whose release restores the entry; undefined while only sessionless calls wrote. */
  owner?: string;
  actions: Map<string, KillProfileRestoreAction>;
}

export interface OwnedKillProfileRestore {
  device: BootedDevice;
  actions: KillProfileRestoreAction[];
}

/**
 * Per-device, write-once record of each facet's state before a kill profile
 * first changed it (#14051), so re-applying a profile never overwrites the
 * original with the already-applied state. In memory only: a daemon restart
 * loses it (reset then offers `baseline: true`).
 *
 * A session that applies a profile takes ownership of the device's entry, so
 * its release restores every facet recorded there, including any a sessionless
 * call changed first. An entry only sessionless calls wrote stays until reset.
 */
export class KillProfileRestoreRegistry {
  private readonly entries = new Map<string, KillProfileRestoreEntry>();

  has(deviceId: string, key: string): boolean {
    return this.entries.get(deviceId)?.actions.has(key) ?? false;
  }

  /** Record `action` unless its facet is already recorded. Returns true when this call recorded it. */
  record(
    device: BootedDevice,
    action: KillProfileRestoreAction,
    owner: string | undefined,
  ): boolean {
    const entry: KillProfileRestoreEntry = this.entries.get(device.deviceId) ?? {
      device,
      actions: new Map(),
    };
    this.entries.set(device.deviceId, entry);
    entry.device = device;
    if (owner !== undefined) {
      entry.owner = owner;
    }
    if (entry.actions.has(action.key)) {
      return false;
    }
    entry.actions.set(action.key, { ...action });
    return true;
  }

  /** Drop one facet: it was restored, or the write that recorded it was refused. */
  forget(deviceId: string, key: string): void {
    const entry = this.entries.get(deviceId);
    entry?.actions.delete(key);
    if (entry && entry.actions.size === 0) {
      this.entries.delete(deviceId);
    }
  }

  /** What reset restores for `appId`: its own facets plus the device-wide ones. */
  pendingFor(deviceId: string, appId: string): KillProfileRestoreAction[] {
    const actions = this.entries.get(deviceId)?.actions.values() ?? [];
    return [...actions].filter((action) => action.appId === undefined || action.appId === appId);
  }

  /** Whether a session release will restore this device's recorded facets. */
  restoresOnRelease(deviceId: string): boolean {
    return this.entries.get(deviceId)?.owner !== undefined;
  }

  /** Remove and return the entry `sessionId` owns on `deviceId`, for its release to restore. */
  takeOwnedBy(deviceId: string, sessionId: string): OwnedKillProfileRestore | undefined {
    const entry = this.entries.get(deviceId);
    if (entry?.owner !== sessionId) {
      return undefined;
    }
    this.entries.delete(deviceId);
    return { device: entry.device, actions: [...entry.actions.values()] };
  }

  /** The device is gone (or its serial now names another device): nothing left to restore. */
  retireDevice(deviceId: string): void {
    this.entries.delete(deviceId);
  }
}

export const defaultKillProfileRestoreRegistry = new KillProfileRestoreRegistry();

/**
 * Run every restore command a released session left, each bounded and outside
 * the releasing request's abort context (cleanup must outlive the call that
 * triggered it). Best effort: a failed command is logged and the rest still
 * run. Resolves with the facet keys that could not be restored.
 */
export async function restoreKillProfileFacets(
  owned: OwnedKillProfileRestore,
  shellFor: KillProfileShellFactory,
  timer: Pick<Timer, "setTimeout" | "clearTimeout">,
): Promise<string[]> {
  const shell = shellFor(owned.device);
  const failed: string[] = [];
  for (const action of owned.actions) {
    const command = action.command;
    if (command === null) {
      continue;
    }
    try {
      const result = await runOutsideRequestContext(() =>
        raceWithDeadline(
          () =>
            shell.executeCommand(command, {
              timeoutMs: KILL_PROFILE_RESTORE_TIMEOUT_MS,
              noRetry: true,
            }),
          {
            timer,
            timeoutMs: KILL_PROFILE_RESTORE_TIMEOUT_MS,
            label: `Restore kill-profile ${action.key}`,
          },
        ),
      );
      if (outputLooksLikeShellFailure(result.stdout, result.stderr ?? "")) {
        throw new Error(`${result.stdout}\n${result.stderr ?? ""}`.trim());
      }
    } catch (error) {
      failed.push(action.key);
      logger.warn(
        `Failed to restore kill-profile ${action.key} on ${owned.device.deviceId} with '${command}': ${errorMessage(error)}`,
        error,
      );
    }
  }
  return failed;
}
