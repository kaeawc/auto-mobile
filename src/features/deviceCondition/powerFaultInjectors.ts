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
 * Power-domain fault injectors for `deviceCondition.faults` (#14063): battery,
 * low-power mode, Doze, and thermal throttling. All are Android-only and
 * root-free (`dumpsys`/`settings`/`cmd`), each paired with its documented reset
 * and a read-back so release can verify a clean device. Version-sensitive verbs
 * (`deviceidle`, `thermalservice`) probe their capability first and fail with an
 * "unsupported on this image" error that the controller surfaces as `unsupported`
 * rather than half-applying.
 *
 * Injectors are factory functions (not classes) so the whole family stays in one
 * file under the repo's one-class-per-file rule.
 */

/** Android thermal severities the surface exposes, mapped to framework status ints. */
const THERMAL_SEVERITY: Record<string, number> = { throttling: 3, critical: 4 };

const BATTERY_VALUES = ["unplug", "low", "full"] as const;

/** `dumpsys battery` charge/plug faults, reset with `dumpsys battery reset`. */
export function createBatteryFaultInjector(adb: AdbExecutor): DeviceConditionInjector {
  const readState = async (signal?: AbortSignal): Promise<string> => {
    const out = await shell(adb, ["dumpsys", "battery"], signal);
    if (!/Current Battery Service state/i.test(out)) {
      unsupported("`dumpsys battery` did not return a battery dump");
    }
    return out;
  };
  return {
    key: "faults.battery",
    async apply(value, signal): Promise<DeviceConditionApplyOutcome> {
      if (!BATTERY_VALUES.includes(value as never)) {
        rejectValue("faults.battery", value, BATTERY_VALUES);
      }
      await readState(signal);
      if (value === "unplug") {
        await shell(adb, ["dumpsys", "battery", "unplug"], signal);
      } else if (value === "low") {
        await shell(adb, ["dumpsys", "battery", "unplug"], signal);
        await shell(adb, ["dumpsys", "battery", "set", "level", "15"], signal);
      } else {
        await shell(adb, ["dumpsys", "battery", "set", "level", "100"], signal);
      }
      return {
        status: "applied",
        detail: `battery ${value}`,
        reset: async (resetSignal) => {
          await shell(adb, ["dumpsys", "battery", "reset"], resetSignal);
        },
      };
    },
    // After `reset`, the emulator restores a live power source; a forced unplug leaves none.
    async isClean(signal): Promise<boolean> {
      const out = await shell(adb, ["dumpsys", "battery"], signal);
      return /(AC|USB|Wireless) powered: true/i.test(out);
    },
  };
}

/** `settings global low_power`, captured and restored so release returns the real value. */
export function createLowPowerFaultInjector(adb: AdbExecutor): DeviceConditionInjector {
  const read = (signal?: AbortSignal): Promise<string> =>
    shell(adb, ["settings", "get", "global", "low_power"], signal);
  let baseline = "null";
  return {
    key: "faults.lowPower",
    async apply(value, signal): Promise<DeviceConditionApplyOutcome> {
      if (value !== "on") {
        rejectValue("faults.lowPower", value, ["on"]);
      }
      baseline = (await read(signal)) || "null";
      await shell(adb, ["settings", "put", "global", "low_power", "1"], signal);
      return {
        status: "applied",
        detail: "low power mode on",
        reset: async (resetSignal) => {
          if (baseline === "null" || baseline === "") {
            await shell(adb, ["settings", "delete", "global", "low_power"], resetSignal);
          } else {
            await shell(adb, ["settings", "put", "global", "low_power", baseline], resetSignal);
          }
        },
      };
    },
    async isClean(signal): Promise<boolean> {
      const current = (await read(signal)) || "null";
      return current === baseline || current === "0" || current === "null";
    },
  };
}

/** `dumpsys deviceidle force-idle`, reset with `unforce`; probes the verb first. */
export function createDozeFaultInjector(adb: AdbExecutor): DeviceConditionInjector {
  const ensureSupported = async (signal?: AbortSignal): Promise<void> => {
    const help = await shell(adb, ["dumpsys", "deviceidle", "-h"], signal).catch(() => "");
    if (!/force-idle/.test(help)) {
      unsupported("`dumpsys deviceidle` has no force-idle verb");
    }
  };
  return {
    key: "faults.doze",
    async apply(value, signal): Promise<DeviceConditionApplyOutcome> {
      if (value !== "on") {
        rejectValue("faults.doze", value, ["on"]);
      }
      await ensureSupported(signal);
      // force-idle requires the device be off charge; unplug first (reset undoes both).
      await shell(adb, ["dumpsys", "battery", "unplug"], signal);
      await shell(adb, ["dumpsys", "deviceidle", "force-idle", "deep"], signal);
      return {
        status: "applied",
        detail: "doze forced",
        reset: async (resetSignal) => {
          await shell(adb, ["dumpsys", "deviceidle", "unforce"], resetSignal);
          await shell(adb, ["dumpsys", "battery", "reset"], resetSignal);
        },
      };
    },
    async isClean(signal): Promise<boolean> {
      const state = await shell(adb, ["dumpsys", "deviceidle", "get", "deep"], signal).catch(
        () => "",
      );
      // After `unforce` the deep-idle state leaves IDLE for ACTIVE.
      return state !== "" && !/IDLE/i.test(state);
    },
  };
}

const THERMAL_VALUES = ["throttling", "critical"] as const;

/** `cmd thermalservice override-status`, reset with `reset`; probes the verb first. */
export function createThermalFaultInjector(adb: AdbExecutor): DeviceConditionInjector {
  const ensureSupported = async (signal?: AbortSignal): Promise<void> => {
    const help = await shell(adb, ["cmd", "thermalservice"], signal).catch(() => "");
    if (!/override-status/.test(help)) {
      unsupported("`cmd thermalservice` has no override-status verb");
    }
  };
  return {
    key: "faults.thermal",
    async apply(value, signal): Promise<DeviceConditionApplyOutcome> {
      const severity = THERMAL_SEVERITY[value];
      if (severity === undefined) {
        rejectValue("faults.thermal", value, THERMAL_VALUES);
      }
      await ensureSupported(signal);
      await shell(adb, ["cmd", "thermalservice", "override-status", String(severity)], signal);
      return {
        status: "applied",
        detail: `thermal ${value}`,
        reset: async (resetSignal) => {
          await shell(adb, ["cmd", "thermalservice", "reset"], resetSignal);
        },
      };
    },
    // No stable per-status read-back; a successful `reset` clears the override.
    async isClean(signal): Promise<boolean> {
      const out = await shell(adb, ["dumpsys", "thermalservice"], signal).catch(() => "");
      return !/is status override:\s*true/i.test(out);
    },
  };
}

/** The injectable seams a test overrides; production uses the default adb factory. */
export interface PowerFaultInjectorDeps {
  adbFactory?: AdbClientFactory;
}

/**
 * Build the injector for one `faults.*` key on an Android device, or undefined
 * when the key is not a power fault or the device is not Android. The
 * deviceCondition registry calls this as its resolver (#14050 seam).
 */
export function resolvePowerFaultInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  deps: PowerFaultInjectorDeps = {},
): DeviceConditionInjector | undefined {
  if (device.platform !== "android") {
    return undefined;
  }
  const adb = (deps.adbFactory ?? defaultAdbClientFactory).create(device);
  switch (key) {
    case "faults.battery":
      return createBatteryFaultInjector(adb);
    case "faults.lowPower":
      return createLowPowerFaultInjector(adb);
    case "faults.doze":
      return createDozeFaultInjector(adb);
    case "faults.thermal":
      return createThermalFaultInjector(adb);
    default:
      return undefined;
  }
}
