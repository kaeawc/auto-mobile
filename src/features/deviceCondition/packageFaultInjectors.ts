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
import {
  createSerializer,
  rejectValue,
  resolveAppUserWith,
  shell,
  unsupported,
  type ResolveAppUser,
} from "./injectorSupport";

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

/** An app on one Android user: the `pm` subcommands default to user 0, or to every user when listing. */
interface AppOnUser {
  packageName: string;
  userId: number;
}

const appKey = (app: AppOnUser): string => `${app.userId}|${app.packageName}`;

/** Whether `pm list packages --user <id> <flags> <name>` lists exactly this package (the filter is a substring). */
async function listsPackage(
  adb: AdbExecutor,
  flags: readonly string[],
  app: AppOnUser,
  signal?: AbortSignal,
): Promise<boolean> {
  const out = await shell(
    adb,
    ["pm", "list", "packages", "--user", String(app.userId), ...flags, app.packageName],
    signal,
  );
  return out.split("\n").some((line) => line.trim() === `package:${app.packageName}`);
}

const isInstalled = (adb: AdbExecutor, app: AppOnUser, signal?: AbortSignal) =>
  listsPackage(adb, [], app, signal);

const isDisabled = (adb: AdbExecutor, app: AppOnUser, signal?: AbortSignal) =>
  listsPackage(adb, ["-d"], app, signal);

const pmArgs = (action: string, app: AppOnUser): string[] => [
  "pm",
  action,
  "--user",
  String(app.userId),
  app.packageName,
];

/**
 * `faults.disablePackage`: disable the app for the Android user it runs in and read back that it
 * took. Reset re-enables every app this injector disabled, newest first; an app that was already
 * disabled before AutoMobile touched it is left alone and not owned.
 */
export function createDisablePackageInjector(
  adb: AdbExecutor,
  resolveUser: ResolveAppUser = resolveAppUserWith(adb),
): DeviceConditionInjector {
  /** Apps this injector disabled and has not yet re-enabled, in disable order. */
  const owned = new Map<string, AppOnUser>();
  const serialize = createSerializer();

  const enable = async (app: AppOnUser, signal?: AbortSignal): Promise<void> => {
    if (!(await isInstalled(adb, app, signal))) {
      return;
    }
    await shell(adb, pmArgs("enable", app), signal);
    if (await isDisabled(adb, app, signal)) {
      throw new ActionableError(`${app.packageName} is still disabled after pm enable.`);
    }
  };

  const restoreNow = async (signal?: AbortSignal): Promise<void> => {
    const failures: string[] = [];
    for (const [key, app] of [...owned].reverse()) {
      try {
        await enable(app, signal);
        owned.delete(key);
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        logger.warn(`re-enabling ${app.packageName} failed: ${errorMessage(error)}`, error);
        failures.push(`${app.packageName}: ${errorMessage(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new ActionableError(`Could not re-enable: ${failures.join("; ")}`);
    }
  };

  /** Idempotent: a no-op once nothing is owned, so the controller may hold several. */
  const reset = (signal?: AbortSignal): Promise<void> => serialize(() => restoreNow(signal));

  /** Undo a failed disable; if that fails too, hand the reset to the controller so release retries it. */
  const rollBack = async (app: AppOnUser, error: unknown): Promise<never> => {
    try {
      await enable(app);
      owned.delete(appKey(app));
    } catch (restoreError) {
      logger.warn(`package rollback failed: ${errorMessage(restoreError)}`, restoreError);
      throw new OwedResetError(
        `${errorMessage(error)} Rollback also failed (${errorMessage(restoreError)}); ${app.packageName} may still be disabled, and release will retry.`,
        reset,
        { cause: error },
      );
    }
    throw error;
  };

  const disable = async (
    app: AppOnUser,
    signal?: AbortSignal,
  ): Promise<DeviceConditionApplyOutcome> => {
    // Own the app before the write, so a failure after it is still undone.
    owned.set(appKey(app), app);
    try {
      await shell(adb, pmArgs("disable-user", app), signal);
      if (!(await isDisabled(adb, app, signal))) {
        unsupported(`pm disable-user did not disable ${app.packageName}`);
      }
    } catch (error) {
      return rollBack(app, error);
    }
    return { status: "applied", detail: `disabled ${app.packageName}`, reset };
  };

  const applyNow = async (
    params: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<DeviceConditionApplyOutcome> => {
    const packageName = parsePackage("faults.disablePackage", params);
    const app: AppOnUser = { packageName, userId: await resolveUser(packageName, signal) };
    if (!(await isInstalled(adb, app, signal))) {
      unsupported(`${packageName} is not installed`);
    }
    if (await isDisabled(adb, app, signal)) {
      return {
        status: "unchanged",
        detail: `${packageName} is already disabled`,
        ...(owned.has(appKey(app)) ? { reset } : {}),
      };
    }
    return disable(app, signal);
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
    // Clean means every app this injector disabled is enabled again.
    async isClean(signal): Promise<boolean> {
      const disabled = await Promise.all(
        [...owned.values()].map((app) => isDisabled(adb, app, signal)),
      );
      return !disabled.includes(true);
    },
  };
}

/**
 * `faults.clearPackageData`: `pm clear` the app for the Android user it runs in. One-shot: there
 * is nothing to restore, so the outcome carries no reset and `isClean` is always true. The
 * session's mutation journal records the clear as a destructive-app intent instead (see
 * `deviceStateFallbackMutations`), so a keep-booted device is not reused with the data gone.
 */
export function createClearPackageDataInjector(
  adb: AdbExecutor,
  resolveUser: ResolveAppUser = resolveAppUserWith(adb),
): DeviceConditionInjector {
  return {
    key: "faults.clearPackageData",
    async apply(value, signal, params): Promise<DeviceConditionApplyOutcome> {
      if (value !== DEVICE_CONDITION_APPLY) {
        rejectValue("faults.clearPackageData", value, ["{ package }"]);
      }
      const packageName = parsePackage("faults.clearPackageData", params);
      const app: AppOnUser = { packageName, userId: await resolveUser(packageName, signal) };
      if (!(await isInstalled(adb, app, signal))) {
        unsupported(`${packageName} is not installed`);
      }
      const out = await shell(adb, pmArgs("clear", app), signal);
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
