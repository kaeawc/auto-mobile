import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type {
  DeviceConditionApplyOutcome,
  DeviceConditionInjector,
} from "./DeviceConditionController";
import type { DeviceConditionKey } from "./DeviceConditionTypes";
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { OwedResetError } from "./OwedResetError";
import { rejectValue, shell, unsupported } from "./injectorSupport";

/**
 * Process-lifecycle fault injectors for `deviceCondition.faults` (#14068). Android
 * only and root-free. Each is paired with a reset and a read-back so release can
 * verify a clean device.
 *
 * Only the stateful fault is here: "Don't keep activities". Killing a background
 * process or sending a trim-memory level are one-shot actions against a named
 * package and need a parameterised request shape, so they are not part of this
 * enum-valued surface yet.
 */

/** Keys this module owns, under the `faults.` prefix of the deviceCondition surface. */
export const LIFECYCLE_FAULT_KEYS = ["faults.dontKeepActivities"] as const;

/** The Developer options "Don't keep activities" switch. */
const ALWAYS_FINISH_ACTIVITIES = "always_finish_activities";

const unsetValue = "null";

/**
 * `dumpsys activity processes` prints this line only while the running ActivityManager has the
 * behaviour on. AOSP reads `always_finish_activities` at boot and from its `setAlwaysFinish`
 * binder call, so writing the setting alone may leave the live state off; this is the read-back
 * that tells the two apart.
 */
const LIVE_STATE_MARKER = "mAlwaysFinishActivities=true";

/**
 * `settings global always_finish_activities 1`: the system destroys each activity
 * as soon as the user leaves it, so apps that lose state on a background kill show
 * it immediately. It applies to activities left after the change, not ones already
 * stopped. The prior value is captured once and restored on reset, so repeating the
 * request never records the fault's own value as the baseline.
 */
export function createDontKeepActivitiesFaultInjector(adb: AdbExecutor): DeviceConditionInjector {
  const read = async (signal?: AbortSignal): Promise<string> =>
    (await shell(adb, ["settings", "get", "global", ALWAYS_FINISH_ACTIVITIES], signal)) ||
    unsetValue;
  const write = (value: string, signal?: AbortSignal): Promise<string> =>
    shell(adb, ["settings", "put", "global", ALWAYS_FINISH_ACTIVITIES, value], signal);
  // The grep runs on the device (adb joins the argv for its shell); `; true` keeps no-match from failing.
  const liveOn = async (signal?: AbortSignal): Promise<boolean> =>
    (
      await shell(
        adb,
        [
          "dumpsys",
          "activity",
          "processes",
          "|",
          "grep",
          `${LIVE_STATE_MARKER.split("=")[0]};`,
          "true",
        ],
        signal,
      )
    ).includes(LIVE_STATE_MARKER);
  /** The setting reads on AND the running activity manager follows it; throws unsupported otherwise. */
  const verifyOn = async (signal?: AbortSignal): Promise<void> => {
    if ((await read(signal)) !== "1") {
      unsupported(`\`settings put global ${ALWAYS_FINISH_ACTIVITIES} 1\` did not take effect`);
    }
    if (!(await liveOn(signal))) {
      unsupported(
        `the running activity manager ignored ${ALWAYS_FINISH_ACTIVITIES} (it only reads it at boot), so Don't keep activities cannot be switched on without a reboot`,
      );
    }
  };
  /** The value to restore while the fault is applied; undefined when this injector owns nothing. */
  let baseline: string | undefined;

  /** Put the baseline back and keep owning it until a read-back shows it took effect. */
  const restore = async (signal?: AbortSignal): Promise<void> => {
    if (baseline === undefined) {
      return;
    }
    if (baseline === unsetValue) {
      await shell(adb, ["settings", "delete", "global", ALWAYS_FINISH_ACTIVITIES], signal);
    } else {
      await write(baseline, signal);
    }
    const now = await read(signal);
    if (now !== baseline) {
      throw new ActionableError(
        `Restoring ${ALWAYS_FINISH_ACTIVITIES} to ${baseline} did not take effect (reads ${now}).`,
      );
    }
    baseline = undefined;
  };

  /** Undo a failed apply; if that fails too, hand the reset to the controller so release retries it. */
  const rollBack = async (error: unknown): Promise<never> => {
    try {
      await restore();
    } catch (restoreError) {
      logger.warn(
        `dontKeepActivities rollback failed: ${errorMessage(restoreError)}`,
        restoreError,
      );
      throw new OwedResetError(
        `${errorMessage(error)} Rollback also failed (${errorMessage(restoreError)}); Don't keep activities may still be on, and release will retry.`,
        restore,
        { cause: error },
      );
    }
    throw error;
  };

  return {
    key: "faults.dontKeepActivities",
    async apply(value, signal): Promise<DeviceConditionApplyOutcome> {
      if (value !== "on") {
        rejectValue("faults.dontKeepActivities", value, ["on"]);
      }
      const current = await read(signal);
      if (baseline !== undefined) {
        // Already ours: re-assert in case something flipped it, and keep the one reset. A
        // reassertion that does not hold is an error, not "unchanged"; the reset stays owed.
        if (current !== "1") {
          await write("1", signal);
        }
        await verifyOn(signal);
        return { status: "unchanged", detail: "Don't keep activities already on" };
      }
      if (current === "1") {
        // Not ours, so nothing to own or undo; but "already on" must be true of the running system.
        await verifyOn(signal);
        return { status: "unchanged", detail: "Don't keep activities was already on" };
      }
      // Own the fault before the first write, so a failure after it is still undone.
      baseline = current;
      try {
        await write("1", signal);
        await verifyOn(signal);
      } catch (error) {
        return rollBack(error);
      }
      return {
        status: "applied",
        detail: "Don't keep activities on",
        reset: restore,
      };
    },
    async isClean(signal): Promise<boolean> {
      return (await read(signal)) !== "1" && !(await liveOn(signal));
    },
  };
}

/** The injectable seams a test overrides; production uses the default adb factory and cache. */
export interface LifecycleFaultInjectorDeps {
  adbFactory?: AdbClientFactory;
  cache?: Map<string, DeviceConditionInjector>;
}

/** One injector per device, so every apply shares its baseline and registers a single reset. */
const injectorsByDevice = new Map<string, DeviceConditionInjector>();

/**
 * Build (once per device) the injector for one lifecycle `faults.*` key on an Android
 * device, or undefined when the key is not one of them or the device is not Android.
 * The registry resolves on every apply, so without the cache a repeat apply after the
 * setting drifted would create a second injector that registers a second reset.
 */
export function resolveLifecycleFaultInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  deps: LifecycleFaultInjectorDeps = {},
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || key !== "faults.dontKeepActivities") {
    return undefined;
  }
  const cache = deps.cache ?? injectorsByDevice;
  let injector = cache.get(device.deviceId);
  if (!injector) {
    injector = createDontKeepActivitiesFaultInjector(
      (deps.adbFactory ?? defaultAdbClientFactory).create(device),
    );
    cache.set(device.deviceId, injector);
  }
  return injector;
}
