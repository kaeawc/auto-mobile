import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { runOutsideRequestContext } from "../../utils/AbortContext";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { DeviceConditionInjector } from "./DeviceConditionController";
import type { DeviceConditionKey } from "./DeviceConditionTypes";
import { OwedResetError } from "./OwedResetError";
import { createSerializer, rejectValue, shell, unsupported } from "./injectorSupport";
import {
  defaultDeviceTraits,
  type DeviceTraits,
} from "../../utils/android-cmdline-tools/deviceTraits";

/**
 * Vehicle-state injectors for `deviceCondition.vehicle`: Automotive emulator motion and night mode.
 * Motion uses gear/brake events and renewable continuous speed events; reset lets the last speed
 * burst lapse before restoring the original properties. Night mode uses the car service's policy
 * override and resets to sensor control. Both verify the effective service state before success.
 */

/** Keys this module owns, under the `vehicle.` prefix of the deviceCondition surface. */
export const VEHICLE_STATE_KEYS = ["vehicle.motion", "vehicle.nightMode"] as const;
type VehicleStateKey = (typeof VEHICLE_STATE_KEYS)[number];

/** VHAL property ids (VehicleProperty.aidl); every one is a global property, area 0. */
const GEAR_SELECTION = "0x11400400";
const PERF_VEHICLE_SPEED = "0x11600207";
const PARKING_BRAKE_ON = "0x11200402";

const GEAR_PARK = "4";
const GEAR_DRIVE = "8";
/** Metres per second; comfortably above any driving-restriction speed threshold. */
const DRIVING_SPEED = "10.0";

type PropertyValues = Record<string, string>;

/** The properties each requested value sets, written in order. */
const MOTION_TARGETS: Record<string, PropertyValues> = {
  parked: { [GEAR_SELECTION]: GEAR_PARK, [PERF_VEHICLE_SPEED]: "0.0", [PARKING_BRAKE_ON]: "1" },
  driving: {
    [GEAR_SELECTION]: GEAR_DRIVE,
    [PERF_VEHICLE_SPEED]: DRIVING_SPEED,
    [PARKING_BRAKE_ON]: "0",
  },
};

// Short bursts renew for arbitrarily long leases without leaving an uncancellable day-long stream.
const SPEED_BURST_SECONDS = 5;
const SPEED_RENEW_MS = 4_000;
const MOTION_WAIT_MS = 5_000;
const MOTION_POLL_MS = 500;
const MOVING_STABLE_MS = 2_000;

const FIRST_NUMBER = /(?:int32Values|floatValues|value)\W*[:=]\s*\[?\s*(-?\d+(?:\.\d+)?)/i;
const COMMAND_FAILURE = /\b(unknown command|exception|error)\b/i;

/** The first number a `get-property-value` reply carries, or undefined when it has none. */
export function parsePropertyValue(output: string): string | undefined {
  return FIRST_NUMBER.exec(output)?.[1];
}

function sameValue(a: string, b: string): boolean {
  return Number.parseFloat(a) === Number.parseFloat(b);
}

/**
 * Why this device cannot take vehicle state, or undefined when it can. Traits confirm the
 * automotive image and emulator directly rather than trusting caller-supplied device metadata.
 */
async function unsupportedReason(
  adb: AdbExecutor,
  device: BootedDevice,
  traits: DeviceTraits,
): Promise<string | undefined> {
  const read = await traits.read(adb, device.deviceId);
  if (read.formFactor !== "automotive") {
    return "vehicle state needs an Android Automotive emulator, and this device is not one";
  }
  if (read.isEmulator !== true) {
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
/** Only the current numeric state is evidence; "Driving State Clients:" is just a header. */
async function readDrivingState(
  adb: AdbExecutor,
  signal?: AbortSignal,
): Promise<{ state: number; line: string } | undefined> {
  const out = await shell(
    adb,
    ["dumpsys", "car_service", "--services", "CarDrivingStateService"],
    signal,
  );
  const match = /^[ \t]*Current Driving State:[ \t]*(\d+)[ \t]*$/m.exec(out);
  return match ? { state: Number(match[1]), line: match[0].trim() } : undefined;
}

async function carCommand(adb: AdbExecutor, args: string[], signal?: AbortSignal): Promise<void> {
  const out = await shell(adb, ["cmd", "car_service", ...args], signal);
  if (COMMAND_FAILURE.test(out) || /invalid|usage:/i.test(out)) {
    unsupported(`car service ${args[0]} failed: ${out.split("\n")[0]}`);
  }
}

async function readNightMode(adb: AdbExecutor, signal?: AbortSignal): Promise<boolean> {
  const out = await shell(adb, ["cmd", "uimode", "night"], signal);
  const mode = /^Night mode:[ \t]*(yes|no)[ \t]*$/m.exec(out)?.[1];
  if (mode === undefined) {
    unsupported(`could not read effective night mode: ${out}`);
  }
  return mode === "yes";
}

function createNightModeInjector(adb: AdbExecutor): DeviceConditionInjector {
  const serial = createSerializer();
  let baseline: boolean | undefined;
  let expected: boolean | undefined;
  const restore = (signal?: AbortSignal): Promise<void> =>
    serial(async () => {
      if (baseline === undefined) {
        return;
      }
      await carCommand(adb, ["day-night-mode", "sensor"], signal);
      baseline = undefined;
      // Sensor control can legitimately choose a different effective mode than the baseline.
      expected = undefined;
    });
  return {
    key: "vehicle.nightMode",
    apply: (value, signal) =>
      serial(async () => {
        const current = await readNightMode(adb, signal);
        const target = value === "on";
        if (current === target) {
          return {
            status: "unchanged",
            detail: `vehicle nightMode already ${value} (Night mode: ${current ? "yes" : "no"})`,
            ...(baseline === undefined ? {} : { reset: restore }),
          };
        }
        const prior = baseline;
        baseline ??= current;
        expected = baseline;
        let wrote = false;
        try {
          await carCommand(adb, ["day-night-mode", target ? "night" : "day"], signal);
          wrote = true;
          const actual = await readNightMode(adb, signal);
          if (actual !== target) {
            throw new ActionableError(
              `vehicle nightMode ${value} did not take effect (Night mode: ${actual ? "yes" : "no"})`,
            );
          }
          return {
            status: "applied",
            detail: `vehicle nightMode ${value} (Night mode: ${actual ? "yes" : "no"})`,
            reset: restore,
          };
        } catch (error) {
          if (wrote) {
            throw new OwedResetError(errorMessage(error), restore, { cause: error });
          }
          baseline = prior;
          throw toActionableError(error, "Could not set vehicle night mode");
        }
      }),
    async isClean(signal) {
      return expected === undefined || (await readNightMode(adb, signal)) === expected;
    },
  };
}

/** A renewable, finite speed stream sharing the injector's apply/reset serializer. */
class VehicleSpeedInjection {
  active = false;
  failure: ActionableError | undefined;
  private renewalHandle: NodeJS.Timeout | undefined;
  private settlesAt = 0;

  constructor(
    private readonly adb: AdbExecutor,
    private readonly timer: Timer,
    private readonly serial: ReturnType<typeof createSerializer>,
  ) {}

  private async inject(signal?: AbortSignal): Promise<void> {
    // CarService timestamps each sample one burst-duration into the future. Allow both the
    // stream and its final timestamp to lapse before a baseline speed event can supersede it.
    this.settlesAt = this.timer.now() + SPEED_BURST_SECONDS * 2_000 + 100;
    await carCommand(
      this.adb,
      [
        "inject-continuous-events",
        PERF_VEHICLE_SPEED,
        DRIVING_SPEED,
        "-s",
        "10",
        "-d",
        String(SPEED_BURST_SECONDS),
      ],
      signal,
    );
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.active) {
      return;
    }
    await this.inject(signal);
    this.active = true;
    this.scheduleRenewal();
  }

  private scheduleRenewal(): void {
    this.renewalHandle = runOutsideRequestContext(() =>
      this.timer.setTimeout(() => {
        void this.serial(async () => {
          if (!this.active) {
            return;
          }
          try {
            await this.inject();
            this.scheduleRenewal();
          } catch (error) {
            this.failure = toActionableError(error, "Could not sustain vehicle driving speed");
            logger.warn(this.failure.message, this.failure);
            this.active = false;
          }
        });
      }, SPEED_RENEW_MS),
    );
    this.renewalHandle.unref?.();
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.renewalHandle !== undefined) {
      this.timer.clearTimeout(this.renewalHandle);
      this.renewalHandle = undefined;
    }
    const remaining = this.settlesAt - this.timer.now();
    if (remaining > 0) {
      await this.timer.sleep(remaining);
    }
    this.failure = undefined;
  }
}

function motionMatches(driving: boolean, state: number | undefined): boolean {
  return driving ? state === 2 : state === 0 || state === 1;
}

async function waitForMotion(
  adb: AdbExecutor,
  timer: Timer,
  driving: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = timer.now() + MOTION_WAIT_MS;
  let movingSince: number | undefined;
  for (;;) {
    const current = await readDrivingState(adb, signal);
    const line = current?.line ?? "Current Driving State: unavailable";
    const matches = motionMatches(driving, current?.state);
    if (matches) {
      movingSince ??= timer.now();
      if (!driving || timer.now() - movingSince >= MOVING_STABLE_MS) {
        return line;
      }
    } else {
      movingSince = undefined;
    }
    const remaining = deadline - timer.now();
    if (remaining <= 0) {
      throw new ActionableError(
        `vehicle motion ${driving ? "driving" : "parked"} did not take effect (${line}); expected ${driving ? "stable Current Driving State: 2" : "Current Driving State: 0 or 1"}`,
      );
    }
    await timer.sleep(Math.min(MOTION_POLL_MS, remaining));
  }
}

async function motionAlreadyApplied(
  adb: AdbExecutor,
  speed: VehicleSpeedInjection,
  current: PropertyValues,
  target: PropertyValues,
  driving: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  if (speed.failure) {
    return false;
  }
  const state = await readDrivingState(adb, signal);
  if (!motionMatches(driving, state?.state)) {
    return false;
  }
  if (driving) {
    return speed.active;
  }
  return (
    !speed.active &&
    Object.keys(target).every((property) => sameValue(current[property], target[property]))
  );
}

async function writeMotionProperties(
  access: ReturnType<typeof createVehiclePropertyAccess>,
  target: PropertyValues,
  driving: boolean,
  onWritten: () => void,
  signal?: AbortSignal,
): Promise<void> {
  for (const [property, value] of Object.entries(target)) {
    if (property !== PERF_VEHICLE_SPEED || !driving) {
      await access.write(property, value, signal);
      onWritten();
    }
  }
}

function createMotionInjector(adb: AdbExecutor, timer: Timer): DeviceConditionInjector {
  const access = createVehiclePropertyAccess(adb);
  const serial = createSerializer();
  const speed = new VehicleSpeedInjection(adb, timer, serial);
  let baseline: PropertyValues | undefined;
  let expected: PropertyValues | undefined;
  const readAll = async (signal?: AbortSignal): Promise<PropertyValues> => {
    const values: PropertyValues = {};
    for (const property of Object.keys(MOTION_TARGETS.parked)) {
      values[property] = await access.read(property, signal);
    }
    return values;
  };
  const restore = (signal?: AbortSignal): Promise<void> =>
    serial(async () => {
      if (baseline === undefined) {
        return;
      }
      await speed.stop();
      for (const [property, value] of Object.entries(baseline)) {
        await access.write(property, value, signal);
      }
      await waitForMotion(adb, timer, !sameValue(baseline[PERF_VEHICLE_SPEED], "0"), signal);
      baseline = undefined;
    });

  return {
    key: "vehicle.motion",
    apply: (value, signal) =>
      serial(async () => {
        const target = MOTION_TARGETS[value];
        const current = await readAll(signal);
        const driving = value === "driving";
        if (await motionAlreadyApplied(adb, speed, current, target, driving, signal)) {
          const line = await waitForMotion(adb, timer, driving, signal);
          return {
            status: "unchanged",
            detail: `vehicle motion already ${value} (${line})`,
            ...(baseline === undefined ? {} : { reset: restore }),
          };
        }
        const prior = baseline;
        baseline ??= current;
        expected = baseline;
        let wrote = false;
        try {
          if (!driving || speed.failure) {
            await speed.stop();
          }
          await writeMotionProperties(
            access,
            target,
            driving,
            () => {
              wrote = true;
            },
            signal,
          );
          if (driving) {
            await speed.start(signal);
          }
          const line = await waitForMotion(adb, timer, driving, signal);
          if (speed.failure) {
            throw speed.failure;
          }
          return { status: "applied", detail: `vehicle motion ${value} (${line})`, reset: restore };
        } catch (error) {
          if (wrote || speed.active) {
            throw new OwedResetError(errorMessage(error), restore, { cause: error });
          }
          baseline = prior;
          throw toActionableError(error, "Could not set vehicle motion");
        }
      }),
    async isClean(signal) {
      if (expected === undefined) {
        return true;
      }
      const current = await readAll(signal);
      const state = await readDrivingState(adb, signal);
      const driving = !sameValue(expected[PERF_VEHICLE_SPEED], "0");
      return (
        !speed.active &&
        motionMatches(driving, state?.state) &&
        Object.entries(expected).every(([property, value]) => sameValue(current[property], value))
      );
    },
  };
}

/** One vehicle key, serialised across applies and resets, with injected device I/O and time. */
export function createVehicleStateInjector(
  key: VehicleStateKey,
  adb: AdbExecutor,
  device: BootedDevice,
  traits: DeviceTraits = defaultDeviceTraits,
  timer: Timer = defaultTimer,
): DeviceConditionInjector {
  const injector =
    key === "vehicle.motion" ? createMotionInjector(adb, timer) : createNightModeInjector(adb);
  const allowed = key === "vehicle.motion" ? Object.keys(MOTION_TARGETS) : ["on", "off"];
  return {
    ...injector,
    async apply(value, signal) {
      if (!allowed.includes(value)) {
        rejectValue(key, value, allowed);
      }
      const reason = await unsupportedReason(adb, device, traits);
      if (reason !== undefined) {
        unsupported(reason);
      }
      return injector.apply(value, signal);
    },
  };
}

/** The injectable seams a test overrides; production uses the default adb factory and cache. */
export interface VehicleStateInjectorDeps {
  adbFactory?: AdbClientFactory;
  cache?: Map<string, DeviceConditionInjector>;
  traits?: DeviceTraits;
  timer?: Timer;
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
      deps.traits,
      deps.timer,
    );
    cache.set(cacheKey, injector);
  }
  return injector;
}
