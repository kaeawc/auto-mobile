import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
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
import type { DeviceConditionKey } from "./DeviceConditionTypes";
import { OwedResetError } from "./OwedResetError";
import { adbCommand, createSerializer, rejectValue, shell, unsupported } from "./injectorSupport";
import { assertRootableImage, ensureRootAdb } from "./rootStateInjector";

const MOUNT = "/storage/emulated";

/** Parse toybox mount output for the exact shared-storage mount; ambiguous/missing modes fail closed. */
export function parseEmulatedStorageMount(output: string): "ro" | "rw" | undefined {
  const mounts = output
    .split("\n")
    .filter((line) => /^\S+ on \/storage\/emulated type \S+ \([^)]*\)$/.test(line.trim()));
  if (mounts.length !== 1) {
    return undefined;
  }
  const options = mounts[0]
    .slice(mounts[0].indexOf("(") + 1, mounts[0].lastIndexOf(")"))
    .split(",");
  const ro = options.includes("ro");
  const rw = options.includes("rw");
  return ro === rw ? undefined : ro ? "ro" : "rw";
}

/** An unreadable probe must not claim ownership of pre-existing privileges. */
async function probeRoot(adb: AdbExecutor, signal?: AbortSignal): Promise<boolean | undefined> {
  try {
    return (await shell(adb, ["id", "-u"], signal)) === "0";
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    logger.warn(
      `readOnlyFilesystem root probe failed; preserving existing privileges: ${errorMessage(error)}`,
      error,
    );
    return undefined;
  }
}

/** Device-wide FUSE superblock remount: every app writing /sdcard sees EROFS. No files are created. */
export function createReadOnlyFilesystemInjector(adb: AdbExecutor): DeviceConditionInjector {
  const serialize = createSerializer();
  let owned = false;
  let acquiredRoot = false;
  const readMode = async (signal?: AbortSignal) =>
    parseEmulatedStorageMount(await shell(adb, ["mount"], signal));
  const remount = async (mode: "ro" | "rw", signal?: AbortSignal): Promise<void> => {
    await shell(adb, ["mount", "-o", `remount,${mode}`, MOUNT], signal);
    if ((await readMode(signal)) !== mode) {
      throw new ActionableError(`${MOUNT} remount ${mode} read-back did not verify.`);
    }
  };
  const restoreNow = async (signal?: AbortSignal): Promise<void> => {
    if (!owned) {
      return;
    }
    const rootedAtRestore = await probeRoot(adb, signal);
    const notRootedAtProbe = rootedAtRestore === false;
    if (!rootedAtRestore) {
      // Record privileges cleanup before restarting the transport, including a failed wait.
      acquiredRoot ||= notRootedAtProbe;
      await ensureRootAdb(adb, signal);
    }
    await remount("rw", signal);
    if (acquiredRoot || notRootedAtProbe) {
      await adbCommand(adb, ["unroot"], signal);
      acquiredRoot = false;
    }
    owned = false;
  };
  const reset = (signal?: AbortSignal): Promise<void> => serialize(() => restoreNow(signal));
  const checkRootableImage = async (signal?: AbortSignal): Promise<void> => {
    try {
      await assertRootableImage(adb, signal, "faults.readOnlyFilesystem");
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      unsupported(errorMessage(error));
    }
  };
  const acquireRoot = async (signal?: AbortSignal): Promise<void> => {
    const wasRooted = (await probeRoot(adb, signal)) ?? true;
    // A repeat apply after mount drift must retain the original privilege cleanup.
    acquiredRoot ||= !wasRooted;
    try {
      await ensureRootAdb(adb, signal);
    } catch (error) {
      if (acquiredRoot) {
        try {
          // Do not reacquire transport or use the aborted apply signal for rollback.
          await adbCommand(adb, ["unroot"]);
          acquiredRoot = false;
        } catch (restoreError) {
          owned = true;
          logger.warn(
            `readOnlyFilesystem root rollback failed: ${errorMessage(restoreError)}`,
            restoreError,
          );
          throw new OwedResetError(
            `${errorMessage(error)} Rollback also failed (${errorMessage(restoreError)}); root was left on, and release will retry.`,
            reset,
            { cause: error },
          );
        }
      }
      if (signal?.aborted) {
        throw error;
      }
      unsupported(errorMessage(error));
    }
  };
  const applyNow = async (
    value: string,
    signal?: AbortSignal,
  ): Promise<DeviceConditionApplyOutcome> => {
    if (value !== "on") {
      rejectValue("faults.readOnlyFilesystem", value, ["on"]);
    }
    await checkRootableImage(signal);
    const mode = await readMode(signal);
    if (mode === undefined) {
      unsupported(`cannot read the ${MOUNT} mount options`);
    }
    if (mode === "ro") {
      return { status: "unchanged", detail: "Shared storage is already read-only for every app." };
    }
    const wasOwned = owned;
    await acquireRoot(signal);
    // Own the remount before its first mutation, including a command that fails after changing it.
    owned = true;
    try {
      await remount("ro", signal);
    } catch (error) {
      try {
        await restoreNow();
      } catch (restoreError) {
        logger.warn(
          `readOnlyFilesystem rollback failed: ${errorMessage(restoreError)}`,
          restoreError,
        );
        throw new OwedResetError(
          `${errorMessage(error)} Rollback also failed (${errorMessage(restoreError)}); shared storage may still be read-only, and release will retry.`,
          reset,
          { cause: error },
        );
      }
      if (signal?.aborted) {
        throw error;
      }
      unsupported(errorMessage(error));
    }
    return {
      status: "applied",
      detail:
        "Shared storage /sdcard is read-only for every app (device-wide); writes fail with EROFS.",
      ...(wasOwned ? {} : { reset }),
    };
  };
  return {
    key: "faults.readOnlyFilesystem",
    apply: (value, signal) => serialize(() => applyNow(value, signal)),
    async isClean(signal): Promise<boolean> {
      try {
        const mode = await readMode(signal);
        if (mode === undefined) {
          logger.warn(`readOnlyFilesystem clean check could not read ${MOUNT} mount options`);
        }
        return mode === "rw" && !acquiredRoot;
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        logger.warn(`readOnlyFilesystem clean check failed: ${errorMessage(error)}`, error);
        return false;
      }
    },
  };
}

export interface ReadOnlyFilesystemInjectorDeps {
  adbFactory?: AdbClientFactory;
  cache?: Map<string, DeviceConditionInjector>;
}
const injectorsByDevice = new Map<string, DeviceConditionInjector>();

/** Cache one injector per Android device so every apply shares ownership and its single reset. */
export function resolveReadOnlyFilesystemInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  deps: ReadOnlyFilesystemInjectorDeps = {},
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || key !== "faults.readOnlyFilesystem") {
    return undefined;
  }
  const cache = deps.cache ?? injectorsByDevice;
  let injector = cache.get(device.deviceId);
  if (!injector) {
    injector = createReadOnlyFilesystemInjector(
      (deps.adbFactory ?? defaultAdbClientFactory).create(device),
    );
    cache.set(device.deviceId, injector);
  }
  return injector;
}
