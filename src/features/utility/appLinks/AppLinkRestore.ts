import type { BootedDevice } from "../../../models";
import { runOutsideRequestContext } from "../../../utils/AbortContext";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { AppLinksDevice } from "./AdbAppLinksDevice";
import {
  appLinkRestoreTarget,
  type AppLinkSettableState,
  type AppLinksSnapshot,
} from "./appLinksOutput";

/** Bound on each `pm` command a restore runs. */
export const APP_LINKS_RESTORE_COMMAND_TIMEOUT_MS = 3_000;

/** A package's App Links state before `setAppLinks` first changed it (#14110). */
export interface AppLinksRestoreEntry {
  device: BootedDevice;
  packageName: string;
  /** The session whose release restores the entry; undefined while only sessionless calls wrote. */
  owner?: string;
  /** autoVerify domain -> state, recorded before the first verification-state change. */
  verification?: ReadonlyMap<string, string>;
  /** userId -> enabled domains, recorded before the first user-selection change for that user. */
  selections: Map<number, readonly string[]>;
}

/** What a restore will write, computed against the current state. */
export interface AppLinksRestorePlan {
  verification: Map<AppLinkSettableState, string[]>;
  selections: { userId: number; enable: string[]; disable: string[] }[];
  /** Domains whose original state the shell cannot set, and what they are restored as. */
  inexact: { domain: string; original: string; restoredAs: AppLinkSettableState }[];
}

/** Which parts of the state an action changes, so only those are recorded. */
export interface AppLinksRecordScope {
  verification: boolean;
  userId?: number;
}

const entryKey = (deviceId: string, packageName: string): string =>
  `${deviceId}\u0000${packageName}`;

/**
 * Per-device, per-package, write-once record of App Links state before the
 * first `setAppLinks` change. In memory only: a daemon restart loses it, and the
 * device keeps the last written state.
 *
 * A session that changes a package takes ownership of its entry, so its release
 * restores everything recorded there, including what a sessionless call changed
 * first. An entry only sessionless calls wrote stays until `action: "restore"`.
 */
export class AppLinksRestoreRegistry {
  private readonly entries = new Map<string, AppLinksRestoreEntry>();

  get(deviceId: string, packageName: string): AppLinksRestoreEntry | undefined {
    return this.entries.get(entryKey(deviceId, packageName));
  }

  /** Record the parts of `snapshot` named by `scope` unless already recorded. */
  record(
    device: BootedDevice,
    packageName: string,
    snapshot: AppLinksSnapshot,
    { scope, owner }: { scope: AppLinksRecordScope; owner?: string },
  ): AppLinksRestoreEntry {
    const key = entryKey(device.deviceId, packageName);
    const entry: AppLinksRestoreEntry = this.entries.get(key) ?? {
      device,
      packageName,
      selections: new Map(),
    };
    this.entries.set(key, entry);
    entry.device = device;
    if (entry.owner === undefined && owner !== undefined) {
      entry.owner = owner;
    }
    if (scope.verification) {
      // Approve records only writable domains; later actions can add other domains.
      // Each domain's first original still wins.
      entry.verification = new Map([...snapshot.verification, ...(entry.verification ?? [])]);
    }
    if (scope.userId !== undefined && !entry.selections.has(scope.userId)) {
      entry.selections.set(scope.userId, [...(snapshot.user?.enabled ?? [])]);
    }
    return entry;
  }

  /** Remove and return one package's entry (restored, or nothing left to restore). */
  take(deviceId: string, packageName: string): AppLinksRestoreEntry | undefined {
    const key = entryKey(deviceId, packageName);
    const entry = this.entries.get(key);
    this.entries.delete(key);
    return entry;
  }

  /** Remove and return every entry `sessionId` owns on `deviceId`, for its release to restore. */
  takeOwnedBy(deviceId: string, sessionId: string): AppLinksRestoreEntry[] {
    const owned = [...this.entries.entries()].filter(
      ([, entry]) => entry.device.deviceId === deviceId && entry.owner === sessionId,
    );
    for (const [key] of owned) {
      this.entries.delete(key);
    }
    return owned.map(([, entry]) => entry);
  }

  /** The device is gone (or its serial now names another device): nothing left to restore. */
  retireDevice(deviceId: string): void {
    for (const [key, entry] of [...this.entries.entries()]) {
      if (entry.device.deviceId === deviceId) {
        this.entries.delete(key);
      }
    }
  }
}

export const defaultAppLinksRestoreRegistry = new AppLinksRestoreRegistry();

function planVerification(
  original: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
  plan: AppLinksRestorePlan,
): void {
  for (const [domain, state] of original) {
    const now = current.get(domain);
    if (now === undefined || now === state) {
      // Undeclared now (app updated) or already back: nothing to write.
      continue;
    }
    const target = appLinkRestoreTarget(state);
    if (now === target.state) {
      continue;
    }
    plan.verification.set(target.state, [...(plan.verification.get(target.state) ?? []), domain]);
    if (!target.exact) {
      plan.inexact.push({ domain, original: state, restoredAs: target.state });
    }
  }
}

/**
 * The writes that return `current` to what `entry` recorded. Domains the
 * package no longer declares are skipped.
 */
export function planAppLinksRestore(
  entry: Pick<AppLinksRestoreEntry, "verification" | "selections">,
  current: { verification: ReadonlyMap<string, string>; users: Map<number, AppLinksSnapshot> },
): AppLinksRestorePlan {
  const plan: AppLinksRestorePlan = { verification: new Map(), selections: [], inexact: [] };
  if (entry.verification) {
    planVerification(entry.verification, current.verification, plan);
  }
  for (const [userId, originalEnabled] of entry.selections) {
    const user = current.users.get(userId)?.user;
    if (!user) {
      continue;
    }
    const declared = new Set(user.domains);
    const wanted = new Set(originalEnabled.filter((domain) => declared.has(domain)));
    const now = new Set(user.enabled);
    const enable = [...wanted].filter((domain) => !now.has(domain));
    const disable = [...now].filter((domain) => !wanted.has(domain));
    if (enable.length > 0 || disable.length > 0) {
      plan.selections.push({ userId, enable, disable });
    }
  }
  return plan;
}

export const appLinksRestorePlanIsEmpty = (plan: AppLinksRestorePlan): boolean =>
  plan.verification.size === 0 && plan.selections.length === 0;

/** Read the state a restore compares against: verification, plus each recorded user. */
export async function readAppLinksRestoreBaseline(
  appLinks: AppLinksDevice,
  entry: Pick<AppLinksRestoreEntry, "packageName" | "selections">,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ verification: ReadonlyMap<string, string>; users: Map<number, AppLinksSnapshot> }> {
  const users = new Map<number, AppLinksSnapshot>();
  let verification: ReadonlyMap<string, string> | undefined;
  for (const userId of entry.selections.keys()) {
    const read = await appLinks.read(entry.packageName, userId, options);
    if (read.found) {
      users.set(userId, read.snapshot);
      verification ??= read.snapshot.verification;
    }
  }
  if (!verification) {
    const read = await appLinks.read(entry.packageName, undefined, options);
    verification = read.found ? read.snapshot.verification : new Map();
  }
  return { verification, users };
}

/** Apply a plan's writes, one `pm` command per target state and per user selection change. */
export async function applyAppLinksRestorePlan(
  appLinks: AppLinksDevice,
  packageName: string,
  plan: AppLinksRestorePlan,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  for (const [state, domains] of plan.verification) {
    await appLinks.setVerificationState(packageName, state, domains, options);
  }
  for (const selection of plan.selections) {
    if (selection.enable.length > 0) {
      await appLinks.setUserSelection(packageName, selection.userId, true, {
        domains: selection.enable,
        ...options,
      });
    }
    if (selection.disable.length > 0) {
      await appLinks.setUserSelection(packageName, selection.userId, false, {
        domains: selection.disable,
        ...options,
      });
    }
  }
}

/**
 * Write a released session's recorded App Links state back, outside the
 * releasing request's abort context (cleanup must outlive the call that
 * triggered it), each command bounded. Best effort: a failure is logged and the
 * remaining packages still run. Resolves with the packages that could not be
 * restored.
 */
export async function restoreAppLinksEntries(
  entries: readonly AppLinksRestoreEntry[],
  appLinksFor: (device: BootedDevice) => AppLinksDevice,
): Promise<string[]> {
  const failed: string[] = [];
  const options = { timeoutMs: APP_LINKS_RESTORE_COMMAND_TIMEOUT_MS };
  for (const entry of entries) {
    try {
      await runOutsideRequestContext(async () => {
        const appLinks = appLinksFor(entry.device);
        const baseline = await readAppLinksRestoreBaseline(appLinks, entry, options);
        const plan = planAppLinksRestore(entry, baseline);
        await applyAppLinksRestorePlan(appLinks, entry.packageName, plan, options);
        for (const inexact of plan.inexact) {
          logger.info(
            `[appLinks] Restored ${entry.packageName} ${inexact.domain} as ${inexact.restoredAs}; ` +
              `the shell cannot set its original state ${inexact.original}`,
          );
        }
      });
    } catch (error) {
      failed.push(entry.packageName);
      logger.warn(
        `[appLinks] Failed to restore App Links state of ${entry.packageName} on ${entry.device.deviceId}: ${errorMessage(error)}`,
        error,
      );
    }
  }
  return failed;
}
