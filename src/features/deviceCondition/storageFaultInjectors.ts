import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type {
  DeviceConditionApplyOutcome,
  DeviceConditionInjector,
} from "./DeviceConditionController";
import type { DeviceConditionKey } from "./DeviceConditionTypes";
import { OwedResetError } from "./OwedResetError";
import { createSerializer, rejectValue, shell, unsupported } from "./injectorSupport";

/**
 * Storage fault injectors for `deviceCondition.faults` (#14066). Android only and
 * root-free: a ballast file on `/data` uses up free space until the device reads
 * "low" or "full", so apps can be tested for the I/O errors and install failures
 * (`INSTALL_FAILED_INSUFFICIENT_STORAGE`) that come with it.
 *
 * Read-only remounts and DB/preferences corruption need root and a target app, so
 * they are not part of this enum-valued surface yet.
 */

/** Keys this module owns, under the `faults.` prefix of the deviceCondition surface. */
export const STORAGE_FAULT_KEYS = ["faults.storage"] as const;

const MIB = 1024 * 1024;

/** Free space left on `/data` for each value. `full` leaves just enough for the system to keep running. */
export const STORAGE_FREE_BYTES_LEFT: Readonly<Record<string, number>> = {
  low: 128 * MIB,
  full: 8 * MIB,
};
const STORAGE_VALUES = Object.keys(STORAGE_FREE_BYTES_LEFT);

/** How far above the target the free space may land after allocating (filesystem block rounding). */
const ALLOCATION_SLACK_BYTES = 16 * MIB;

/** The ballast lives in AutoMobile's own namespace on `/data`, so a stale one is safe to replace. */
export const STORAGE_BALLAST_PATH = "/data/local/tmp/automobile-storage-ballast";

/**
 * Free bytes on the filesystem from `df -k <path>` output. The numeric columns are
 * read from the right (`Available Use% Mounted-on`), so a filesystem name with
 * spaces cannot shift them. Throws when no row parses.
 */
export function parseDfAvailableBytes(output: string): number {
  const rows = output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length >= 4 && /^\d+%$/.test(columns[columns.length - 2]));
  const row = rows[rows.length - 1];
  const availableKb = row === undefined ? NaN : Number(row[row.length - 3]);
  if (!Number.isSafeInteger(availableKb) || availableKb < 0) {
    throw new ActionableError(`Could not read free space from \`df -k /data\`: ${output}`);
  }
  return availableKb * 1024;
}

/**
 * `faults.storage`: allocate a ballast file so `/data` is left with a fixed amount of
 * free space. Reset deletes it and reads back that it is gone. A repeat apply
 * (including a change between `low` and `full`) re-sizes the one ballast and keeps
 * the single reset.
 */
export function createStorageFaultInjector(adb: AdbExecutor): DeviceConditionInjector {
  const availableBytes = async (signal?: AbortSignal): Promise<number> =>
    parseDfAvailableBytes(await shell(adb, ["df", "-k", "/data"], signal));
  // `ls` exits nonzero for a missing path, which the client rejects, so end in `; true`.
  const ballastPresent = async (signal?: AbortSignal): Promise<boolean> =>
    (await shell(adb, ["ls", "-d", STORAGE_BALLAST_PATH, "2>/dev/null;", "true"], signal)) !== "";
  const removeBallast = async (signal?: AbortSignal): Promise<void> => {
    await shell(adb, ["rm", "-f", STORAGE_BALLAST_PATH], signal);
    if (await ballastPresent(signal)) {
      throw new ActionableError(`The storage ballast ${STORAGE_BALLAST_PATH} is still present.`);
    }
  };
  const ensureFallocate = async (signal?: AbortSignal): Promise<void> => {
    if ((await shell(adb, ["command", "-v", "fallocate;", "true"], signal)) === "") {
      unsupported("no `fallocate` on this image");
    }
  };

  /** Whether this injector has (or may have) a ballast on the device to remove. */
  let owned = false;

  /**
   * Apply and reset run one at a time. A lease-expiry reset can be in flight when a new apply
   * starts; interleaved, the reset would clear `owned` after the apply had allocated and the
   * ballast would outlive every later reset.
   */
  const serialize = createSerializer();

  const restoreNow = async (signal?: AbortSignal): Promise<void> => {
    if (!owned) {
      return;
    }
    await removeBallast(signal);
    owned = false;
  };

  /**
   * The reset handed to the controller. It is idempotent (a no-op once the ballast is gone), so
   * the controller holding more than one of them, which it clears together, is harmless.
   */
  const reset = (signal?: AbortSignal): Promise<void> => serialize(() => restoreNow(signal));

  /** Undo a failed apply; if that fails too, hand the reset to the controller so release retries it. */
  const rollBack = async (error: unknown): Promise<never> => {
    try {
      await restoreNow();
    } catch (restoreError) {
      logger.warn(`storage fault rollback failed: ${errorMessage(restoreError)}`, restoreError);
      throw new OwedResetError(
        `${errorMessage(error)} Rollback also failed (${errorMessage(restoreError)}); the storage ballast may still be on the device, and release will retry.`,
        reset,
        { cause: error },
      );
    }
    throw error;
  };

  /** Allocate the ballast and check free space really dropped to the target. */
  const fill = async (leftBytes: number, signal?: AbortSignal): Promise<number> => {
    const free = await availableBytes(signal);
    if (free <= leftBytes) {
      return 0;
    }
    const size = free - leftBytes;
    await shell(adb, ["fallocate", "-l", String(size), STORAGE_BALLAST_PATH], signal);
    const after = await availableBytes(signal);
    if (after > leftBytes + ALLOCATION_SLACK_BYTES) {
      unsupported(
        `\`fallocate\` did not reduce free space to the target (${after} bytes free, wanted about ${leftBytes})`,
      );
    }
    return size;
  };

  const applyNow = async (
    value: string,
    signal?: AbortSignal,
  ): Promise<DeviceConditionApplyOutcome> => {
    const leftBytes = STORAGE_FREE_BYTES_LEFT[value];
    if (leftBytes === undefined) {
      rejectValue("faults.storage", value, STORAGE_VALUES);
    }
    await ensureFallocate(signal);
    // Own the ballast before the first write, so a failure after it is still undone.
    owned = true;
    let allocated: number;
    try {
      // A leftover ballast (ours from a crashed session, or a re-size) would hide the true free space.
      await removeBallast(signal);
      allocated = await fill(leftBytes, signal);
    } catch (error) {
      return rollBack(error);
    }
    if (allocated === 0) {
      // Nothing was allocated (any earlier ballast was just removed), so there is nothing left to undo.
      owned = false;
      return {
        status: "unchanged",
        detail: `free space already at or below the ${value} target`,
      };
    }
    return { status: "applied", detail: `storage ${value}: allocated ${allocated} bytes`, reset };
  };

  return {
    key: "faults.storage",
    apply: (value, signal) => serialize(() => applyNow(value, signal)),
    // Clean means no ballast is left; free space also depends on what the app wrote meanwhile.
    async isClean(signal): Promise<boolean> {
      return !(await ballastPresent(signal));
    },
  };
}

/** The injectable seams a test overrides; production uses the default adb factory and cache. */
export interface StorageFaultInjectorDeps {
  adbFactory?: AdbClientFactory;
  cache?: Map<string, DeviceConditionInjector>;
}

/** One injector per device, so every apply shares its ballast ownership and registers a single reset. */
const injectorsByDevice = new Map<string, DeviceConditionInjector>();

/**
 * Build (once per device) the injector for a storage `faults.*` key on an Android
 * device, or undefined when the key is not one of them or the device is not Android.
 * The registry resolves on every apply, so without the cache a `low` then `full`
 * request would create two injectors that each register a reset.
 */
export function resolveStorageFaultInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  deps: StorageFaultInjectorDeps = {},
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || key !== "faults.storage") {
    return undefined;
  }
  const cache = deps.cache ?? injectorsByDevice;
  let injector = cache.get(device.deviceId);
  if (!injector) {
    injector = createStorageFaultInjector(
      (deps.adbFactory ?? defaultAdbClientFactory).create(device),
    );
    cache.set(device.deviceId, injector);
  }
  return injector;
}
