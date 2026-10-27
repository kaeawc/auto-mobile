import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type {
  DeviceConditionApplyOutcome,
  DeviceConditionInjector,
} from "./DeviceConditionController";
import type { DeviceConditionKey } from "./DeviceConditionTypes";
import { OwedResetError } from "./OwedResetError";
import { rejectValue, shell, unsupported } from "./injectorSupport";

/**
 * Vehicle-state injectors for `deviceCondition.vehicle` (#14919): motion and night mode on an
 * Android Automotive emulator, set through the car service's VHAL injection command and
 * restored to the values read before the first change.
 *
 * The `cmd car_service` verbs and the property read-back format are unverified until the AAOS
 * spike (#14916) runs on an emulator; an unreadable property fails closed (`unsupported`) rather
 * than applying a state the injector could not restore.
 */

/** Keys this module owns, under the `vehicle.` prefix of the deviceCondition surface. */
export const VEHICLE_STATE_KEYS = ["vehicle.motion", "vehicle.nightMode"] as const;
type VehicleStateKey = (typeof VEHICLE_STATE_KEYS)[number];

/** VHAL property ids (VehicleProperty.aidl); every one is a global property, area 0. */
const GEAR_SELECTION = "0x11400400";
const PERF_VEHICLE_SPEED = "0x11600207";
const PARKING_BRAKE_ON = "0x11200402";
const NIGHT_MODE = "0x11200407";

const GEAR_PARK = "4";
const GEAR_DRIVE = "8";
/** Metres per second; comfortably above any driving-restriction speed threshold. */
const DRIVING_SPEED = "10.0";

type PropertyValues = Record<string, string>;

/** The properties each requested value sets, written in order. */
const TARGETS: Record<VehicleStateKey, Record<string, PropertyValues>> = {
  "vehicle.motion": {
    parked: { [GEAR_SELECTION]: GEAR_PARK, [PERF_VEHICLE_SPEED]: "0.0", [PARKING_BRAKE_ON]: "1" },
    driving: {
      [GEAR_SELECTION]: GEAR_DRIVE,
      [PERF_VEHICLE_SPEED]: DRIVING_SPEED,
      [PARKING_BRAKE_ON]: "0",
    },
  },
  "vehicle.nightMode": {
    on: { [NIGHT_MODE]: "1" },
    off: { [NIGHT_MODE]: "0" },
  },
};

const FIRST_NUMBER = /(?:int32Values|floatValues|value)\W*[:=]\s*\[?\s*(-?\d+(?:\.\d+)?)/i;
const COMMAND_FAILURE = /\b(unknown command|exception|error)\b/i;

/** The first number a `get-property-value` reply carries, or undefined when it has none. */
export function parsePropertyValue(output: string): string | undefined {
  return FIRST_NUMBER.exec(output)?.[1];
}

function sameValue(a: string, b: string): boolean {
  return Number.parseFloat(a) === Number.parseFloat(b);
}

/** Why this device cannot take vehicle state, or undefined when it can. */
function unsupportedReason(device: BootedDevice): string | undefined {
  if (device.formFactor !== "automotive") {
    return "vehicle state needs an Android Automotive emulator, and this device is not one";
  }
  if (!device.deviceId.startsWith("emulator-")) {
    return "vehicle state is injected on emulators only; a physical head unit has no VHAL injection";
  }
  return undefined;
}

/** Reads and writes global vehicle properties through the car service. */
export function createVehiclePropertyAccess(adb: AdbExecutor) {
  return {
    async read(property: string, signal?: AbortSignal): Promise<string> {
      const out = await shell(adb, ["cmd", "car_service", "get-property-value", property], signal);
      const value = parsePropertyValue(out);
      if (value === undefined) {
        unsupported(`could not read vehicle property ${property}, so it could not be restored`);
      }
      return value;
    },
    async write(property: string, value: string, signal?: AbortSignal): Promise<void> {
      const out = await shell(
        adb,
        ["cmd", "car_service", "inject-vhal-event", property, "0", value],
        signal,
      );
      if (COMMAND_FAILURE.test(out)) {
        unsupported(`\`inject-vhal-event ${property}\` failed: ${out.split("\n")[0]}`);
      }
    },
  };
}
type VehiclePropertyAccess = ReturnType<typeof createVehiclePropertyAccess>;

/** Best-effort: the car service's own driving-state line, so the result shows the restriction state. */
async function readDrivingState(adb: AdbExecutor, signal?: AbortSignal): Promise<string> {
  try {
    const out = await shell(
      adb,
      ["dumpsys", "car_service", "--services", "CarDrivingStateService"],
      signal,
    );
    return /driving state[^\n]*/i.exec(out)?.[0].trim() ?? "";
  } catch (error) {
    // The restriction read-back is a bonus; the vehicle state itself was already verified.
    logger.debug(`driving state read-back failed: ${errorMessage(error)}`);
    return "";
  }
}

/**
 * One vehicle key. The prior property values are read once, before the first change, and held
 * until reset, so changing `motion` from parked to driving never records the fault's own value
 * as the baseline and registers a single reset.
 */
export function createVehicleStateInjector(
  key: VehicleStateKey,
  adb: AdbExecutor,
  device: BootedDevice,
): DeviceConditionInjector {
  const access: VehiclePropertyAccess = createVehiclePropertyAccess(adb);
  const allowed = Object.keys(TARGETS[key]);
  let baseline: PropertyValues | undefined;
  /** What `isClean` compares against after a reset. */
  let expected: PropertyValues | undefined;

  const restore = async (signal?: AbortSignal): Promise<void> => {
    const prior = baseline;
    if (prior === undefined) {
      return;
    }
    for (const [property, value] of Object.entries(prior)) {
      await access.write(property, value, signal);
    }
    baseline = undefined;
  };

  const readAll = async (properties: string[], signal?: AbortSignal): Promise<PropertyValues> => {
    const values: PropertyValues = {};
    for (const property of properties) {
      values[property] = await access.read(property, signal);
    }
    return values;
  };

  return {
    key,
    async apply(value, signal): Promise<DeviceConditionApplyOutcome> {
      const target = TARGETS[key][value];
      if (target === undefined) {
        rejectValue(key, value, allowed);
      }
      const reason = unsupportedReason(device);
      if (reason !== undefined) {
        unsupported(reason);
      }
      const properties = Object.keys(target);
      const current = await readAll(properties, signal);
      if (properties.every((property) => sameValue(current[property], target[property]))) {
        return { status: "unchanged", detail: `vehicle ${key.split(".")[1]} already ${value}` };
      }
      const firstChange = baseline === undefined;
      baseline ??= current;
      expected = baseline;
      try {
        for (const property of properties) {
          await access.write(property, target[property], signal);
        }
      } catch (error) {
        throw new OwedResetError(errorMessage(error), restore, { cause: error });
      }
      const driving = await readDrivingState(adb, signal);
      return {
        status: "applied",
        detail: `vehicle ${key.split(".")[1]} ${value}${driving ? ` (${driving})` : ""}`,
        ...(firstChange ? { reset: restore } : {}),
      };
    },
    async isClean(signal): Promise<boolean> {
      if (expected === undefined) {
        return true;
      }
      const current = await readAll(Object.keys(expected), signal);
      return Object.entries(expected).every(([property, value]) =>
        sameValue(current[property], value),
      );
    },
  };
}

/** The injectable seams a test overrides; production uses the default adb factory and cache. */
export interface VehicleStateInjectorDeps {
  adbFactory?: AdbClientFactory;
  cache?: Map<string, DeviceConditionInjector>;
}

/** One injector per device and key, so every apply shares its baseline and registers a single reset. */
const injectorsByDeviceKey = new Map<string, DeviceConditionInjector>();

/** The injector for a `vehicle.*` key on an Android device, or undefined for any other key or platform. */
export function resolveVehicleStateInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  deps: VehicleStateInjectorDeps = {},
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || !VEHICLE_STATE_KEYS.includes(key as VehicleStateKey)) {
    return undefined;
  }
  const cache = deps.cache ?? injectorsByDeviceKey;
  const cacheKey = `${device.deviceId}\u0000${key}`;
  let injector = cache.get(cacheKey);
  if (!injector) {
    injector = createVehicleStateInjector(
      key as VehicleStateKey,
      (deps.adbFactory ?? defaultAdbClientFactory).create(device),
      device,
    );
    cache.set(cacheKey, injector);
  }
  return injector;
}
