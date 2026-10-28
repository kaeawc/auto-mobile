import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { invalidateDisplayCaches } from "../observe/DisplayTransition";
import {
  AndroidDeviceClockAdapter,
  DEVICE_CLOCK_TOLERANCE_MS,
  defaultDeviceClockRestoreRegistry,
  readDeviceClock,
  writeDeviceClock,
  type DeviceClockAdapter,
  type DeviceClockDependencies,
  type DeviceClockRestoreRegistry,
  type DeviceClockState,
} from "../utility/DeviceClock";
import type {
  DeviceConditionApplyOutcome,
  DeviceConditionInjector,
} from "./DeviceConditionController";
import {
  DEVICE_CONDITION_APPLY,
  clockSkewParamsSchema,
  type DeviceConditionKey,
} from "./DeviceConditionTypes";
import { OwedResetError } from "./OwedResetError";
import { createSerializer, rejectValue, unsupported } from "./injectorSupport";

/**
 * `faults.clockSkew` (#14069): put the device clock `offsetSeconds` ahead of (or behind) real
 * time, so an app can be tested against a wrong clock: expired tokens and certificates, stale
 * caches, scheduling. Reset restores real (host) time and the original automatic-time setting.
 *
 * It drives the same clock control as `setDeviceState.clock` and shares its per-device queue and
 * restore baseline, so the two never record each other's skewed clock as "the original". The
 * clock is device-global: a reset from either surface restores real time for both. Rootable
 * Android emulators only; setting the clock needs `adb root`, which restarts adbd.
 *
 * A repeat skew while one is applied moves the clock again and keeps the one reset the first
 * skew registered. A skew that fails to verify still hands the controller its reset, because the
 * clock may have moved before the failure.
 */

export const CLOCK_FAULT_KEYS = ["faults.clockSkew"] as const;

export interface ClockFaultInjectorDeps {
  /** A fresh adapter per operation, so it carries the clock registry's current incarnation signal. */
  adapter: () => DeviceClockAdapter;
  hostClock: Pick<Timer, "now">;
  registry: DeviceClockRestoreRegistry;
  invalidate: (deviceId: string) => void;
}

/** A clock result that changed nothing on the device, so there is nothing to reset. */
const nothingOwed = (result: DeviceClockState): boolean =>
  !result.supported || result.outcome === "unchanged";

export function createClockSkewFaultInjector(
  device: BootedDevice,
  deps: ClockFaultInjectorDeps,
): DeviceConditionInjector {
  const serialize = createSerializer();
  const clockDeps: DeviceClockDependencies = {
    hostClock: deps.hostClock,
    invalidate: deps.invalidate,
    restoreRegistry: deps.registry,
  };
  // True while this injector holds a skew whose reset the controller owes.
  let active = false;

  /** Restore real time and the original auto_time; throws (reset stays owed) unless it verifies. */
  const restore = (signal?: AbortSignal): Promise<void> =>
    serialize(async () => {
      signal?.throwIfAborted();
      const result = await writeDeviceClock(
        device,
        deps.adapter(),
        { mode: "reset" },
        undefined,
        clockDeps,
      );
      if (!result.verified) {
        throw new ActionableError(
          `clockSkew reset did not restore real time: ${result.error ?? "read-back did not verify"}`,
        );
      }
      active = false;
    });

  const applySkew = async (
    offsetSeconds: number,
    signal?: AbortSignal,
  ): Promise<DeviceConditionApplyOutcome> => {
    signal?.throwIfAborted();
    const target = deps.hostClock.now() + offsetSeconds * 1000;
    const instant = new Date(target).toISOString();
    const result = await writeDeviceClock(
      device,
      deps.adapter(),
      { mode: "set", instant },
      undefined,
      clockDeps,
    );
    if (nothingOwed(result) && !active) {
      if (!result.supported) {
        unsupported(result.error ?? "clock control is not available on this device");
      }
      return { status: "unchanged", detail: `device clock already reads ${instant}` };
    }
    if (result.verified === false || result.error) {
      // The clock may have moved before the failure; the controller must still owe the reset.
      const message = `clockSkew did not verify: ${result.error ?? "read-back did not match"}`;
      if (active) {
        throw new ActionableError(`${message}. The earlier skew's reset is still owed.`);
      }
      active = true;
      throw new OwedResetError(`${message}. Release will restore real time.`, restore);
    }
    const detail = `device clock set to ${instant} (${offsetSeconds > 0 ? "+" : ""}${offsetSeconds}s from real time)`;
    if (active) {
      // The reset registered by the first skew still restores real time.
      return { status: "applied", detail };
    }
    active = true;
    return { status: "applied", detail, reset: restore };
  };

  return {
    key: "faults.clockSkew",
    apply(value, signal, params): Promise<DeviceConditionApplyOutcome> {
      if (value !== DEVICE_CONDITION_APPLY) {
        rejectValue("faults.clockSkew", value, ["{ offsetSeconds }"]);
      }
      const parsed = clockSkewParamsSchema().safeParse(params);
      if (!parsed.success) {
        unsupported(
          `invalid clockSkew parameters: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        );
      }
      return serialize(() => applySkew(parsed.data.offsetSeconds, signal));
    },
    async isClean(signal): Promise<boolean> {
      signal?.throwIfAborted();
      const reading = await readDeviceClock(device, deps.adapter());
      if (reading.instant === undefined) {
        logger.warn(
          `clockSkew clean check could not read the device clock: ${reading.error ?? "no instant"}`,
        );
        return false;
      }
      return (
        Math.abs(Date.parse(reading.instant) - deps.hostClock.now()) <= DEVICE_CLOCK_TOLERANCE_MS
      );
    },
  };
}

/** The injectable seams a test overrides; production uses the default adb factory and clock registry. */
export interface ClockFaultResolverDeps {
  adbFactory?: AdbClientFactory;
  hostClock?: Pick<Timer, "now">;
  registry?: DeviceClockRestoreRegistry;
  cache?: Map<string, DeviceConditionInjector>;
}

/** One injector per device, so a repeat skew shares the one reset the first registered. */
const injectorsByDevice = new Map<string, DeviceConditionInjector>();

/**
 * The `faults.clockSkew` injector for an Android device, or undefined for any other key or
 * platform. The adapter carries the clock registry's incarnation signal, so work queued for a
 * device that was removed is cancelled like `setDeviceState.clock` work.
 */
export function resolveClockFaultInjector(
  device: BootedDevice,
  key: DeviceConditionKey,
  deps: ClockFaultResolverDeps = {},
): DeviceConditionInjector | undefined {
  if (device.platform !== "android" || key !== "faults.clockSkew") {
    return undefined;
  }
  const cache = deps.cache ?? injectorsByDevice;
  let injector = cache.get(device.deviceId);
  if (!injector) {
    const registry = deps.registry ?? defaultDeviceClockRestoreRegistry;
    const adb = (deps.adbFactory ?? defaultAdbClientFactory).create(device);
    injector = createClockSkewFaultInjector(device, {
      adapter: () => new AndroidDeviceClockAdapter(adb, registry.signal(device.deviceId)),
      hostClock: deps.hostClock ?? defaultTimer,
      registry,
      invalidate: (deviceId) => {
        try {
          invalidateDisplayCaches(deviceId, "Device clock changed");
        } catch (error) {
          // Cache invalidation is best-effort: a stale cache refreshes on the next observe.
          logger.warn(`clockSkew cache invalidation failed: ${errorMessage(error)}`, error);
        }
      },
    });
    cache.set(device.deviceId, injector);
  }
  return injector;
}
