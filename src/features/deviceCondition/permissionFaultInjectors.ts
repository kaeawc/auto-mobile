import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { z } from "zod";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { normalizeAndroidPermissionName } from "../action/GrantAndroidPermissions";
import { parseAndroidRuntimePermissions } from "../action/parseAndroidRuntimePermissions";
import type {
  DeviceConditionApplyOutcome,
  DeviceConditionInjector,
} from "./DeviceConditionController";
import {
  ANDROID_PACKAGE_NAME_PATTERN,
  ANDROID_PERMISSION_NAME_PATTERN,
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
 * `faults.revokePermission` (#14069): revoke one runtime permission from an installed app with
 * `pm revoke`, so the app can be tested against a permission the user withdrew mid-session. Reset
 * re-grants it. `pm revoke` kills the app's process, so a revoke also restarts the app; that is a
 * compound fault, not a side effect to hide. Android only and root-free.
 */

/** Keys this module owns, under the `faults.` prefix of the deviceCondition surface. */
export const PERMISSION_FAULT_KEYS = ["faults.revokePermission"] as const;

const paramsSchema = z
  .object({
    package: z.string().regex(ANDROID_PACKAGE_NAME_PATTERN),
    permission: z.string().regex(ANDROID_PERMISSION_NAME_PATTERN),
  })
  .strict();

type PermissionState = "granted" | "denied";

interface RequestedTarget {
  packageName: string;
  permission: string;
}

/** The permission on the Android user whose instance of the app is being tested. */
interface Target extends RequestedTarget {
  userId: number;
}

const targetKey = (target: Target): string =>
  `${target.userId}|${target.packageName}|${target.permission}`;

const pmArgs = (action: "grant" | "revoke", target: Target): string[] => [
  "pm",
  action,
  "--user",
  String(target.userId),
  target.packageName,
  target.permission,
];

/** What `dumpsys package` says about one runtime permission, or why it cannot be revoked. */
type PermissionReading =
  | { kind: "state"; state: PermissionState }
  | { kind: "refused"; reason: string };

async function readPermission(
  adb: AdbExecutor,
  target: Target,
  signal?: AbortSignal,
): Promise<PermissionReading | "package-missing"> {
  const result = await adb.execute(["shell", "dumpsys", "package", target.packageName], {
    maxBuffer: DUMPSYS_MAX_BUFFER,
    noRetry: true,
    signal,
  });
  if (result.error) {
    throw new ActionableError(`dumpsys package ${target.packageName} failed: ${result.error}`);
  }
  const state = parseAndroidRuntimePermissions(
    result.stdout.replace(/\r\n?/g, "\n"),
    target.packageName,
    target.userId,
  );
  if (state === undefined) {
    return "package-missing";
  }
  if (!state.requestedPermissions.has(target.permission)) {
    return {
      kind: "refused",
      reason: `${target.packageName} does not request ${target.permission}`,
    };
  }
  const runtime = state.runtimePermissions.get(target.permission);
  if (runtime === undefined) {
    return {
      kind: "refused",
      reason: `${target.permission} is not a runtime permission of ${target.packageName}, so it cannot be revoked`,
    };
  }
  return { kind: "state", state: runtime.state === "granted" ? "granted" : "denied" };
}

/**
 * The permission's state, or undefined when there is nothing to restore: the package is gone, or an
 * update dropped the permission or made it non-runtime.
 */
async function readState(
  adb: AdbExecutor,
  target: Target,
  signal?: AbortSignal,
): Promise<PermissionState | undefined> {
  const reading = await readPermission(adb, target, signal);
  return reading === "package-missing" || reading.kind === "refused" ? undefined : reading.state;
}

function parseTarget(params: Record<string, unknown> | undefined): RequestedTarget {
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) {
    rejectValue("faults.revokePermission", JSON.stringify(params ?? null), [
      "{ package, permission }",
    ]);
  }
  return {
    packageName: parsed.data.package,
    permission: normalizeAndroidPermissionName(parsed.data.permission),
  };
}

/**
 * `faults.revokePermission`: revoke the named permission and read back that it took. Each revoked
 * (package, permission) pair is re-granted by reset, newest first; a repeat apply on a pair this
 * injector already revoked re-asserts it, and one already denied before AutoMobile touched it is
 * left alone and not owned.
 */
export function createPermissionFaultInjector(
  adb: AdbExecutor,
  resolveUser: ResolveAppUser = resolveAppUserWith(adb),
): DeviceConditionInjector {
  /** Pairs this injector revoked and has not yet re-granted, in revoke order. */
  const owned = new Map<string, Target>();
  const serialize = createSerializer();

  const regrant = async (target: Target, signal?: AbortSignal): Promise<void> => {
    if ((await readState(adb, target, signal)) === undefined) {
      return;
    }
    await shell(adb, pmArgs("grant", target), signal);
    if ((await readState(adb, target, signal)) !== "granted") {
      throw new ActionableError(
        `${target.permission} is still not granted to ${target.packageName} after pm grant.`,
      );
    }
  };

  const restoreNow = async (signal?: AbortSignal): Promise<void> => {
    const failures: string[] = [];
    for (const [key, target] of [...owned].reverse()) {
      try {
        await regrant(target, signal);
        owned.delete(key);
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        logger.warn(
          `re-granting ${target.permission} to ${target.packageName} failed: ${errorMessage(error)}`,
          error,
        );
        failures.push(`${target.packageName} ${target.permission}: ${errorMessage(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new ActionableError(`Could not re-grant: ${failures.join("; ")}`);
    }
  };

  /** Idempotent: a no-op once nothing is owned, so the controller may hold several. */
  const reset = (signal?: AbortSignal): Promise<void> => serialize(() => restoreNow(signal));

  /** Undo a failed revoke; if that fails too, hand the reset to the controller so release retries it. */
  const rollBack = async (target: Target, error: unknown): Promise<never> => {
    try {
      await regrant(target);
      owned.delete(targetKey(target));
    } catch (restoreError) {
      logger.warn(`permission rollback failed: ${errorMessage(restoreError)}`, restoreError);
      throw new OwedResetError(
        `${errorMessage(error)} Rollback also failed (${errorMessage(restoreError)}); ${target.permission} may still be revoked from ${target.packageName}, and release will retry.`,
        reset,
        { cause: error },
      );
    }
    throw error;
  };

  const outcome = (
    status: "applied" | "unchanged",
    target: Target,
    detail: string,
  ): DeviceConditionApplyOutcome => ({
    status,
    detail,
    ...(owned.has(targetKey(target)) ? { reset } : {}),
  });

  const revoke = async (
    target: Target,
    signal?: AbortSignal,
  ): Promise<DeviceConditionApplyOutcome> => {
    // Own the pair before the write, so a failure after it is still undone.
    owned.set(targetKey(target), target);
    try {
      await shell(adb, pmArgs("revoke", target), signal);
      if ((await readState(adb, target, signal)) !== "denied") {
        unsupported(`pm revoke did not revoke ${target.permission} from ${target.packageName}`);
      }
    } catch (error) {
      return rollBack(target, error);
    }
    return outcome(
      "applied",
      target,
      `revoked ${target.permission} from ${target.packageName}; the app's process was killed, so it restarts`,
    );
  };

  const applyNow = async (
    params: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<DeviceConditionApplyOutcome> => {
    const requested = parseTarget(params);
    const target: Target = {
      ...requested,
      userId: await resolveUser(requested.packageName, signal),
    };
    const reading = await readPermission(adb, target, signal);
    if (reading === "package-missing") {
      unsupported(`${target.packageName} is not installed`);
    }
    if (reading.kind === "refused") {
      unsupported(reading.reason);
    }
    if (reading.state === "denied") {
      return outcome(
        "unchanged",
        target,
        `${target.permission} is already revoked from ${target.packageName}`,
      );
    }
    return revoke(target, signal);
  };

  return {
    key: "faults.revokePermission",
    apply: (value, signal, params) =>
      serialize(() => {
        if (value !== DEVICE_CONDITION_APPLY) {
          rejectValue("faults.revokePermission", value, ["{ package, permission }"]);
        }
        return applyNow(params, signal);
      }),
    // Clean means every permission this injector revoked is granted again.
    async isClean(signal): Promise<boolean> {
      const states = await Promise.all([...owned.values()].map((t) => readState(adb, t, signal)));
      return states.every((state) => state !== "denied");
    },
  };
}

/** The injectable seams a test overrides; production uses the default adb factory and cache. */
export interface PermissionFaultInjectorDeps {
  adbFactory?: AdbClientFactory;
  cache?: Map<string, DeviceConditionInjector>;
}

/** One injector per device, so every apply shares its ownership map and registers equivalent resets. */
const injectorsByDevice = new Map<string, DeviceConditionInjector>();

/**
 * Build (once per device) the injector for a permission `faults.*` key on an Android device, or
 * undefined when the key is not one of them or the device is not Android. The registry resolves
 * on every apply, so without the cache each request would get a fresh ownership map.
 */
export function resolvePermissionFaultInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  deps: PermissionFaultInjectorDeps = {},
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || key !== "faults.revokePermission") {
    return undefined;
  }
  const cache = deps.cache ?? injectorsByDevice;
  let injector = cache.get(device.deviceId);
  if (!injector) {
    injector = createPermissionFaultInjector(
      (deps.adbFactory ?? defaultAdbClientFactory).create(device),
    );
    cache.set(device.deviceId, injector);
  }
  return injector;
}
