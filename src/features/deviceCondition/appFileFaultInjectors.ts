import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { z } from "zod";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type {
  DeviceConditionApplyOutcome,
  DeviceConditionInjector,
} from "./DeviceConditionController";
import {
  ANDROID_PACKAGE_NAME_PATTERN,
  APP_FILE_PATH_PATTERN,
  DEVICE_CONDITION_APPLY,
  type DeviceConditionKey,
} from "./DeviceConditionTypes";
import { OwedResetError } from "./OwedResetError";
import {
  createSerializer,
  rejectValue,
  resolveAppUserWith,
  shell,
  unsupported,
  type ResolveAppUser,
} from "./injectorSupport";

/**
 * `faults.corruptAppFile` (#14066): damage one file in a debuggable app's own data directory, such
 * as a SQLite database or a SharedPreferences XML, so the app can be tested against a store that
 * will not open. Android only. It reaches the file with `run-as`, which needs no root but only
 * works for a debuggable app; a release build is refused with that reason.
 *
 * The original is copied beside the file first and the apply records its checksum, so reset puts
 * the bytes back and proves it by checksum, then removes the copy: nothing is left in the app's
 * directory. Both steps force-stop the app, so it does not hold the file open or write it back.
 */

/** Keys this module owns, under the `faults.` prefix of the deviceCondition surface. */
export const APP_FILE_FAULT_KEYS = ["faults.corruptAppFile"] as const;

export const CORRUPT_MODES = ["overwrite", "truncate"] as const;

/** Bytes zeroed at the start of the file by `overwrite`, enough to destroy a SQLite header. */
const OVERWRITE_BYTES = 256;

const BACKUP_SUFFIX = ".automobile-backup";

const paramsSchema = z
  .object({
    package: z.string().regex(ANDROID_PACKAGE_NAME_PATTERN),
    path: z.string().regex(APP_FILE_PATH_PATTERN),
    mode: z.enum(CORRUPT_MODES),
  })
  .strict();

interface Target {
  packageName: string;
  userId: number;
  path: string;
}

interface Owned extends Target {
  /** Checksum of the original, which reset must reproduce. */
  checksum: string;
}

const targetKey = (target: Target): string =>
  `${target.userId}|${target.packageName}|${target.path}`;

const backupPath = (target: Target): string => `${target.path}${BACKUP_SUFFIX}`;

/** `run-as <pkg> --user <id> <command...>`: the command runs as the app, inside its data directory. */
async function runAs(
  adb: AdbExecutor,
  target: Target,
  command: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  return shell(
    adb,
    ["run-as", target.packageName, "--user", String(target.userId), ...command],
    signal,
  );
}

/** The checksum column of `md5sum <path>`. */
async function checksumOf(
  adb: AdbExecutor,
  target: Target,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const out = await runAs(adb, target, ["md5sum", path], signal);
  const checksum = out.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{32}$/i.test(checksum)) {
    throw new ActionableError(`Could not read a checksum of ${path}: ${out || "(no output)"}`);
  }
  return checksum;
}

const forceStop = (adb: AdbExecutor, target: Target, signal?: AbortSignal): Promise<string> =>
  shell(adb, ["am", "force-stop", "--user", String(target.userId), target.packageName], signal);

/** Whether a path exists inside the app's data directory (`ls` exits nonzero when it does not). */
async function exists(
  adb: AdbExecutor,
  target: Target,
  path: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const out = await runAs(adb, target, ["ls", "-d", path, "2>/dev/null;", "true"], signal);
  return out !== "";
}

/** Refuse, with the reason, a file `run-as` cannot reach (a release build, or a missing file). */
async function assertReachable(
  adb: AdbExecutor,
  target: Target,
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (await exists(adb, target, target.path, signal)) {
      return;
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    // `run-as` is refused for a non-debuggable app, which the adb client reports as a failure.
    logger.warn(`run-as ${target.packageName} failed: ${errorMessage(error)}`, error);
    unsupported(
      `cannot reach ${target.path} of ${target.packageName} with run-as (the app must be a debuggable build): ${errorMessage(error)}`,
    );
  }
  unsupported(`${target.path} does not exist in the data directory of ${target.packageName}`);
}

async function damage(
  adb: AdbExecutor,
  target: Target,
  mode: (typeof CORRUPT_MODES)[number],
  signal?: AbortSignal,
): Promise<void> {
  if (mode === "truncate") {
    const size = Number(await runAs(adb, target, ["stat", "-c", "%s", target.path], signal));
    await runAs(adb, target, ["truncate", "-s", String(Math.floor(size / 2)), target.path], signal);
    return;
  }
  await runAs(
    adb,
    target,
    ["dd", "if=/dev/zero", `of=${target.path}`, `bs=${OVERWRITE_BYTES}`, "count=1", "conv=notrunc"],
    signal,
  );
}

/**
 * `faults.corruptAppFile` `{ package, path, mode }`: back the file up, damage it, and read back
 * that its checksum changed. `overwrite` zeroes the first 256 bytes; `truncate` cuts it to half.
 */
export function createCorruptAppFileInjector(
  adb: AdbExecutor,
  resolveUser: ResolveAppUser = resolveAppUserWith(adb),
): DeviceConditionInjector {
  /** Files this injector damaged and has not yet restored, in damage order. */
  const owned = new Map<string, Owned>();
  const serialize = createSerializer();

  const restore = async (entry: Owned, signal?: AbortSignal): Promise<void> => {
    await forceStop(adb, entry, signal);
    const backup = backupPath(entry);
    if (await exists(adb, entry, backup, signal)) {
      await runAs(adb, entry, ["cp", backup, entry.path], signal);
    }
    if ((await checksumOf(adb, entry, entry.path, signal)) !== entry.checksum) {
      throw new ActionableError(
        `${entry.path} of ${entry.packageName} does not match its original after the restore.`,
      );
    }
    await runAs(adb, entry, ["rm", "-f", backup], signal);
  };

  const restoreNow = async (signal?: AbortSignal): Promise<void> => {
    const failures: string[] = [];
    for (const [key, entry] of [...owned].reverse()) {
      try {
        await restore(entry, signal);
        owned.delete(key);
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        logger.warn(`restoring ${entry.path} failed: ${errorMessage(error)}`, error);
        failures.push(`${entry.packageName} ${entry.path}: ${errorMessage(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new ActionableError(`Could not restore: ${failures.join("; ")}`);
    }
  };

  /** Idempotent: a no-op once nothing is owned, so the controller may hold several. */
  const reset = (signal?: AbortSignal): Promise<void> => serialize(() => restoreNow(signal));

  /** Undo a failed apply; if that fails too, hand the reset to the controller so release retries it. */
  const rollBack = async (entry: Owned, error: unknown): Promise<never> => {
    try {
      await restore(entry);
      owned.delete(targetKey(entry));
    } catch (restoreError) {
      logger.warn(`file rollback failed: ${errorMessage(restoreError)}`, restoreError);
      throw new OwedResetError(
        `${errorMessage(error)} Rollback also failed (${errorMessage(restoreError)}); ${entry.path} of ${entry.packageName} may still be damaged, and release will retry.`,
        reset,
        { cause: error },
      );
    }
    throw error;
  };

  const corrupt = async (
    target: Target,
    mode: (typeof CORRUPT_MODES)[number],
    signal?: AbortSignal,
  ): Promise<DeviceConditionApplyOutcome> => {
    const entry: Owned = {
      ...target,
      checksum: await checksumOf(adb, target, target.path, signal),
    };
    // Own the file before the first write, so a failure after it is still undone.
    owned.set(targetKey(entry), entry);
    try {
      await forceStop(adb, target, signal);
      await runAs(adb, target, ["cp", target.path, backupPath(target)], signal);
      await damage(adb, target, mode, signal);
      if ((await checksumOf(adb, target, target.path, signal)) === entry.checksum) {
        unsupported(`${mode} did not change ${target.path} of ${target.packageName}`);
      }
    } catch (error) {
      return rollBack(entry, error);
    }
    return {
      status: "applied",
      detail: `${mode === "truncate" ? "truncated" : "overwrote the first bytes of"} ${target.path} of ${target.packageName}; the app was force-stopped`,
      reset,
    };
  };

  const applyNow = async (
    params: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<DeviceConditionApplyOutcome> => {
    const parsed = paramsSchema.safeParse(params);
    if (!parsed.success) {
      rejectValue("faults.corruptAppFile", JSON.stringify(params ?? null), [
        `{ package, path, mode: ${CORRUPT_MODES.join(" | ")} }`,
      ]);
    }
    const { package: packageName, path, mode } = parsed.data;
    const target: Target = { packageName, path, userId: await resolveUser(packageName, signal) };
    if (owned.has(targetKey(target))) {
      return { status: "unchanged", detail: `${path} is already damaged`, reset };
    }
    await assertReachable(adb, target, signal);
    if (await exists(adb, target, backupPath(target), signal)) {
      unsupported(
        `${backupPath(target)} already exists: an earlier session left it behind. Restore ${path} from it and remove it first.`,
      );
    }
    return corrupt(target, mode, signal);
  };

  return {
    key: "faults.corruptAppFile",
    apply: (value, signal, params) =>
      serialize(() => {
        if (value !== DEVICE_CONDITION_APPLY) {
          rejectValue("faults.corruptAppFile", value, ["{ package, path, mode }"]);
        }
        return applyNow(params, signal);
      }),
    // Clean means every file this injector damaged is back to its original bytes.
    async isClean(signal): Promise<boolean> {
      const results = await Promise.all(
        [...owned.values()].map(
          async (entry) => (await checksumOf(adb, entry, entry.path, signal)) === entry.checksum,
        ),
      );
      return !results.includes(false);
    },
  };
}

/** The injectable seams a test overrides; production uses the default adb factory and cache. */
export interface AppFileFaultInjectorDeps {
  adbFactory?: AdbClientFactory;
  cache?: Map<string, DeviceConditionInjector>;
}

/** One injector per device, so every apply shares its ownership map and registers equivalent resets. */
const injectorsByDevice = new Map<string, DeviceConditionInjector>();

/**
 * Build (once per device) the injector for `faults.corruptAppFile` on an Android device, or
 * undefined for any other key or platform. The registry resolves on every apply, so without the
 * cache each request would get a fresh ownership map.
 */
export function resolveAppFileFaultInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  deps: AppFileFaultInjectorDeps = {},
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || key !== "faults.corruptAppFile") {
    return undefined;
  }
  const cache = deps.cache ?? injectorsByDevice;
  let injector = cache.get(device.deviceId);
  if (!injector) {
    injector = createCorruptAppFileInjector(
      (deps.adbFactory ?? defaultAdbClientFactory).create(device),
    );
    cache.set(device.deviceId, injector);
  }
  return injector;
}
