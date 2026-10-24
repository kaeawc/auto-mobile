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
  DEVICE_CONDITION_APPLY,
  type DeviceConditionKey,
} from "./DeviceConditionTypes";
import { OwedResetError } from "./OwedResetError";
import { createSerializer, rejectValue, shell, unsupported } from "./injectorSupport";

/**
 * Package-state faults for `deviceCondition.faults` (#14069), Android only and root-free:
 *
 * - `disablePackage` (`pm disable-user`): the app cannot launch, receive broadcasts or serve
 *   content until reset runs `pm enable`. Stateful, so it registers a reset.
 * - `clearPackageData` (`pm clear`): wipes the app's data and kills its process. It is one-shot
 *   and cannot be undone, so it registers no reset; what a test does next is its own business.
 */

/** Keys this module owns, under the `faults.` prefix of the deviceCondition surface. */
export const PACKAGE_FAULT_KEYS = ["faults.disablePackage", "faults.clearPackageData"] as const;

const paramsSchema = z.object({ package: z.string().regex(ANDROID_PACKAGE_NAME_PATTERN) }).strict();

function parsePackage(key: DeviceConditionKey, params: Record<string, unknown> | undefined) {
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) {
    rejectValue(key, JSON.stringify(params ?? null), ["{ package }"]);
  }
  return parsed.data.package;
}

/** Whether `pm list packages <flags> <name>` lists exactly this package (the filter is a substring). */
async function listsPackage(
  adb: AdbExecutor,
  flags: readonly string[],
  packageName: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const out = await shell(adb, ["pm", "list", "packages", ...flags, packageName], signal);
  return out.split("\n").some((line) => line.trim() === `package:${packageName}`);
}

const isInstalled = (adb: AdbExecutor, packageName: string, signal?: AbortSignal) =>
  listsPackage(adb, [], packageName, signal);

const isDisabled = (adb: AdbExecutor, packageName: string, signal?: AbortSignal) =>
  listsPackage(adb, ["-d"], packageName, signal);

/**
 * `faults.disablePackage`: disable the app for the current user and read back that it took. Reset
 * re-enables every package this injector disabled, newest first; an app that was already disabled
 * before AutoMobile touched it is left alone and not owned.
 */
export function createDisablePackageInjector(adb: AdbExecutor): DeviceConditionInjector {
  /** Packages this injector disabled and has not yet re-enabled, in disable order. */
  const owned = new Set<string>();
  const serialize = createSerializer();

  const enable = async (packageName: string, signal?: AbortSignal): Promise<void> => {
    if (!(await isInstalled(adb, packageName, signal))) {
      return;
    }
    await shell(adb, ["pm", "enable", packageName], signal);
    if (await isDisabled(adb, packageName, signal)) {
      throw new ActionableError(`${packageName} is still disabled after pm enable.`);
    }
  };

  const restoreNow = async (signal?: AbortSignal): Promise<void> => {
    const failures: string[] = [];
    for (const packageName of [...owned].reverse()) {
      try {
        await enable(packageName, signal);
        owned.delete(packageName);
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        logger.warn(`re-enabling ${packageName} failed: ${errorMessage(error)}`, error);
        failures.push(`${packageName}: ${errorMessage(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new ActionableError(`Could not re-enable: ${failures.join("; ")}`);
    }
  };

  /** Idempotent: a no-op once nothing is owned, so the controller may hold several. */
  const reset = (signal?: AbortSignal): Promise<void> => serialize(() => restoreNow(signal));

  /** Undo a failed disable; if that fails too, hand the reset to the controller so release retries it. */
  const rollBack = async (packageName: string, error: unknown): Promise<never> => {
    try {
      await enable(packageName);
      owned.delete(packageName);
    } catch (restoreError) {
      logger.warn(`package rollback failed: ${errorMessage(restoreError)}`, restoreError);
      throw new OwedResetError(
        `${errorMessage(error)} Rollback also failed (${errorMessage(restoreError)}); ${packageName} may still be disabled, and release will retry.`,
        reset,
        { cause: error },
      );
    }
    throw error;
  };

  const disable = async (
    packageName: string,
    signal?: AbortSignal,
  ): Promise<DeviceConditionApplyOutcome> => {
    // Own the package before the write, so a failure after it is still undone.
    owned.add(packageName);
    try {
      await shell(adb, ["pm", "disable-user", packageName], signal);
      if (!(await isDisabled(adb, packageName, signal))) {
        unsupported(`pm disable-user did not disable ${packageName}`);
      }
    } catch (error) {
      return rollBack(packageName, error);
    }
    return { status: "applied", detail: `disabled ${packageName}`, reset };
  };

  const applyNow = async (
    params: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<DeviceConditionApplyOutcome> => {
    const packageName = parsePackage("faults.disablePackage", params);
    if (!(await isInstalled(adb, packageName, signal))) {
      unsupported(`${packageName} is not installed`);
    }
    if (await isDisabled(adb, packageName, signal)) {
      return {
        status: "unchanged",
        detail: `${packageName} is already disabled`,
        ...(owned.has(packageName) ? { reset } : {}),
      };
    }
    return disable(packageName, signal);
  };

  return {
    key: "faults.disablePackage",
    apply: (value, signal, params) =>
      serialize(() => {
        if (value !== DEVICE_CONDITION_APPLY) {
          rejectValue("faults.disablePackage", value, ["{ package }"]);
        }
        return applyNow(params, signal);
      }),
    // Clean means every package this injector disabled is enabled again.
    async isClean(signal): Promise<boolean> {
      const disabled = await Promise.all(
        [...owned].map((packageName) => isDisabled(adb, packageName, signal)),
      );
      return !disabled.includes(true);
    },
  };
}

/**
 * `faults.clearPackageData`: `pm clear` the app. One-shot: there is nothing to restore, so the
 * outcome carries no reset and `isClean` is always true.
 */
export function createClearPackageDataInjector(adb: AdbExecutor): DeviceConditionInjector {
  return {
    key: "faults.clearPackageData",
    async apply(value, signal, params): Promise<DeviceConditionApplyOutcome> {
      if (value !== DEVICE_CONDITION_APPLY) {
        rejectValue("faults.clearPackageData", value, ["{ package }"]);
      }
      const packageName = parsePackage("faults.clearPackageData", params);
      if (!(await isInstalled(adb, packageName, signal))) {
        unsupported(`${packageName} is not installed`);
      }
      const out = await shell(adb, ["pm", "clear", packageName], signal);
      if (!/\bSuccess\b/.test(out)) {
        unsupported(`pm clear ${packageName} did not report Success: ${out || "(no output)"}`);
      }
      return {
        status: "applied",
        detail: `cleared the data of ${packageName}; this cannot be undone, and the app's process was killed`,
      };
    },
    isClean: () => Promise.resolve(true),
  };
}

/** The injectable seams a test overrides; production uses the default adb factory and cache. */
export interface PackageFaultInjectorDeps {
  adbFactory?: AdbClientFactory;
  cache?: Map<string, DeviceConditionInjector>;
}

/** One injector per device and key, so every apply shares its ownership and registers equivalent resets. */
const injectorsByDeviceAndKey = new Map<string, DeviceConditionInjector>();

/**
 * Build (once per device and key) the injector for a package `faults.*` key on an Android device,
 * or undefined when the key is not one of them or the device is not Android. The registry
 * resolves on every apply, so without the cache each request would get a fresh ownership set.
 */
export function resolvePackageFaultInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  deps: PackageFaultInjectorDeps = {},
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || !(PACKAGE_FAULT_KEYS as readonly string[]).includes(key)) {
    return undefined;
  }
  const cache = deps.cache ?? injectorsByDeviceAndKey;
  const cacheKey = `${device.deviceId}|${key}`;
  let injector = cache.get(cacheKey);
  if (!injector) {
    const adb = (deps.adbFactory ?? defaultAdbClientFactory).create(device);
    injector =
      key === "faults.disablePackage"
        ? createDisablePackageInjector(adb)
        : createClearPackageDataInjector(adb);
    cache.set(cacheKey, injector);
  }
  return injector;
}
