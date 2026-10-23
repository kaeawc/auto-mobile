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
  /** The value to restore while the fault is applied; undefined when this injector owns nothing. */
  let baseline: string | undefined;

  const restore = async (signal?: AbortSignal): Promise<void> => {
    if (baseline === undefined) {
      return;
    }
    if (baseline === unsetValue) {
      await shell(adb, ["settings", "delete", "global", ALWAYS_FINISH_ACTIVITIES], signal);
    } else {
      await write(baseline, signal);
    }
    baseline = undefined;
  };

  return {
    key: "faults.dontKeepActivities",
    async apply(value, signal): Promise<DeviceConditionApplyOutcome> {
      if (value !== "on") {
        rejectValue("faults.dontKeepActivities", value, ["on"]);
      }
      const current = await read(signal);
      if (baseline !== undefined) {
        // Already ours: re-assert in case something flipped it, and keep the one reset.
        if (current !== "1") {
          await write("1", signal);
        }
        return { status: "unchanged", detail: "Don't keep activities already on" };
      }
      if (current === "1") {
        return { status: "unchanged", detail: "Don't keep activities was already on" };
      }
      await write("1", signal);
      if ((await read(signal)) !== "1") {
        unsupported(`\`settings put global ${ALWAYS_FINISH_ACTIVITIES} 1\` did not take effect`);
      }
      baseline = current;
      return {
        status: "applied",
        detail: "Don't keep activities on",
        reset: restore,
      };
    },
    async isClean(signal): Promise<boolean> {
      return (await read(signal)) !== "1";
    },
  };
}

/** The injectable seams a test overrides; production uses the default adb factory. */
export interface LifecycleFaultInjectorDeps {
  adbFactory?: AdbClientFactory;
}

/**
 * Build the injector for one lifecycle `faults.*` key on an Android device, or
 * undefined when the key is not one of them or the device is not Android.
 */
export function resolveLifecycleFaultInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  deps: LifecycleFaultInjectorDeps = {},
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || key !== "faults.dontKeepActivities") {
    return undefined;
  }
  return createDontKeepActivitiesFaultInjector(
    (deps.adbFactory ?? defaultAdbClientFactory).create(device),
  );
}
