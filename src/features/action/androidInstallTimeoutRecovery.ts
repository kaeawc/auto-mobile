import type { AppMetadataResult } from "../../models/AppMetadataResult";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { isPackageInstalledForUser } from "../../utils/android-cmdline-tools/isPackageInstalledForUser";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { getAndroidAppMetadataFromAdb } from "../observe/GetAppMetadata";
import { ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS } from "./installAppTimeout";

/** Package-state reads after a timed-out install are bounded and best-effort. */
const INSTALL_RECOVERY_READ_TIMEOUT_MS = 5_000;
const INSTALL_RECOVERY_POLLS = 3;
const INSTALL_RECOVERY_POLL_INTERVAL_MS = 2_000;

/** What the device reported for the package before the install command was sent. */
export interface AndroidPriorPackageState {
  installed: boolean;
  /** `dumpsys package` snapshot; only read for an upgrade, where presence proves nothing. */
  metadata?: AppMetadataResult | null;
}

export type TimedOutInstallVerdict =
  | { outcome: "completed" }
  | { outcome: "indeterminate"; detail: string };

export interface TimedOutInstallCheck {
  adb: AdbExecutor;
  timer: Timer;
  packageName: string | undefined;
  userId: number;
  prior: AndroidPriorPackageState;
  signal?: AbortSignal;
}

/** Read the version/update fingerprint of an already-installed package; best effort. */
export async function readAndroidPriorPackageState(
  adb: AdbExecutor,
  packageName: string,
  installed: boolean,
  signal?: AbortSignal,
): Promise<AndroidPriorPackageState> {
  if (!installed) {
    return { installed };
  }
  const metadata = await getAndroidAppMetadataFromAdb(adb, packageName, {
    timeoutMs: INSTALL_RECOVERY_READ_TIMEOUT_MS,
    signal,
    optional: true,
  });
  return { installed, metadata };
}

/**
 * `adb install` hitting its step budget only kills the host process; the device-side
 * install session can still commit. Re-read the package state live, a few times, before
 * deciding. A first install is complete once the package is listed; an upgrade is
 * complete only when its versionCode or lastUpdateTime moved off the pre-install
 * snapshot, because the old copy is listed either way.
 */
export async function resolveTimedOutAndroidInstall(
  check: TimedOutInstallCheck,
): Promise<TimedOutInstallVerdict> {
  const { packageName, signal } = check;
  if (!packageName) {
    return {
      outcome: "indeterminate",
      detail:
        "the package name could not be determined from the APK, so the device was not checked",
    };
  }
  let detail = "the device was not checked";
  for (let poll = 0; poll < INSTALL_RECOVERY_POLLS; poll++) {
    if (poll > 0) {
      await check.timer.sleep(INSTALL_RECOVERY_POLL_INTERVAL_MS);
    }
    signal?.throwIfAborted();
    const verdict = await probeTimedOutInstall(check, packageName);
    if (verdict.outcome === "completed") {
      return verdict;
    }
    detail = verdict.detail;
  }
  return { outcome: "indeterminate", detail };
}

async function probeTimedOutInstall(
  check: TimedOutInstallCheck,
  packageName: string,
): Promise<TimedOutInstallVerdict> {
  const { adb, userId, prior, signal } = check;
  try {
    const listed = await isPackageInstalledForUser(
      adb,
      packageName,
      userId,
      INSTALL_RECOVERY_READ_TIMEOUT_MS,
      signal,
    );
    if (!listed) {
      return {
        outcome: "indeterminate",
        detail: `${packageName} is not listed for user ${userId}`,
      };
    }
    if (!prior.installed) {
      return { outcome: "completed" };
    }
    return await probeUpgrade(check, packageName);
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(
      `[InstallApp] Package-state check after install timeout failed: ${errorMessage(error)}`,
      error,
    );
    return {
      outcome: "indeterminate",
      detail: `the package-state check failed: ${errorMessage(error)}`,
    };
  }
}

async function probeUpgrade(
  check: TimedOutInstallCheck,
  packageName: string,
): Promise<TimedOutInstallVerdict> {
  const before = check.prior.metadata;
  if (!before) {
    return {
      outcome: "indeterminate",
      detail: `${packageName} was already installed and its pre-install version could not be read, so an upgrade cannot be told apart from the old copy`,
    };
  }
  const after = await getAndroidAppMetadataFromAdb(check.adb, packageName, {
    timeoutMs: INSTALL_RECOVERY_READ_TIMEOUT_MS,
    signal: check.signal,
    optional: true,
  });
  if (!after) {
    return {
      outcome: "indeterminate",
      detail: `the version of ${packageName} could not be re-read`,
    };
  }
  if (after.buildNumber !== before.buildNumber || after.lastUpdateTime !== before.lastUpdateTime) {
    return { outcome: "completed" };
  }
  return {
    outcome: "indeterminate",
    detail: `${packageName} is still the pre-install copy (versionCode ${before.buildNumber}, lastUpdateTime ${before.lastUpdateTime ?? "unknown"})`,
  };
}

export const ANDROID_INSTALL_OUTLIVED_WARNING =
  "The install command timed out but the device finished installing the package afterwards.";

/** Outcome unknown: sent, possibly still committing. Never a flat "failed". */
export function indeterminateAndroidInstallMessage(
  packageName: string | undefined,
  userId: number,
  detail: string,
): string {
  const target = packageName ? `${packageName} (user ${userId})` : `the APK (user ${userId})`;
  return `Install outcome is indeterminate: adb install of ${target} timed out after ${ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS}ms and the device does not yet report it as complete (${detail}). The install was sent and may still complete; do not retry automatically. Check listApps before retrying.`;
}
