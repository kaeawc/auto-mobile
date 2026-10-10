import { MultiPlatformDeviceManager } from "../../devices/deviceUtils";
import type { DeviceInfo } from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import type { DevicePool } from "../devicePool";
import { defaultManagedSlotToolInvoker } from "./daemonManagedSlotAcquisition";
import { FreeDeviceReclaimer } from "./freeDeviceReclaimer";
import { PoolManagedSlotDeviceStopper } from "./poolManagedSlotDeviceStopper";
import {
  DeviceManagerSlotInventory,
  PoolManagedSlotDeviceClaims,
} from "./managedSlotReconcilerPorts";
import type { LiveExecutionSessions } from "./slotOwnerLiveness";
import type { SlotRegistry } from "./slotRegistry";

/** What the daemon starts and stops; undefined means no sweep runs. */
export type FreeDeviceReclaimerHandle = Pick<FreeDeviceReclaimer, "start" | "stop">;

export type FreeDeviceReclaimerFactory = (deps: {
  registry: () => Promise<SlotRegistry>;
  /** False while the host registry does not exist; the sweep then never creates it. */
  registryExists: () => boolean;
  pool: DevicePool;
  executions: LiveExecutionSessions;
  timer: Timer;
  /** This daemon's id, recorded on its `stopping` claims. */
  claimedBy: string;
}) => FreeDeviceReclaimerHandle | undefined;

export type FreeDeviceBusyPool = Pick<
  DevicePool,
  "getAllDevices" | "isUnderShutdownReservation" | "isDeviceLeasedForAndroidStartup"
>;

/**
 * Why a free-pool device must not be shut down right now, or undefined when it is quiet: a pooled
 * runtime that is not idle (an in-flight boot or control call, or an errored one), one a session
 * holds, one under a shutdown reservation, or an Android startup lease. The pool never reserves a
 * managed-slot (free-pool) device for restart recovery (the slot wins), and that predicate is
 * private to the pool, so it is not consulted here.
 */
export function freeDeviceBusyReason(
  pool: FreeDeviceBusyPool,
  device: Pick<DeviceInfo, "platform" | "name" | "deviceId">,
): string | undefined {
  const runtime = pool
    .getAllDevices()
    .find(
      (pooled) =>
        pooled.platform === device.platform &&
        (device.platform === "android"
          ? (pooled.avdName ?? pooled.name) === device.name
          : pooled.id === device.deviceId),
    );
  if (!runtime) {
    return undefined;
  }
  if (runtime.status !== "idle") {
    return `pooled runtime is ${runtime.status}`;
  }
  if (runtime.sessionId !== null) {
    return "a session holds the runtime";
  }
  if (pool.isUnderShutdownReservation(runtime.id)) {
    return "shutdown reservation";
  }
  return pool.isDeviceLeasedForAndroidStartup(runtime.id) ? "android startup lease" : undefined;
}

/**
 * The daemon's free-pool reclaim sweep (#11337): a device unadopted for an hour is shut down and
 * its image kept. Not armed under `bun test` (`NODE_ENV=test`): the host registry lives under the
 * real home directory, and a test daemon advancing a fake clock must never stop real devices.
 * Tests exercise {@link FreeDeviceReclaimer} directly with fakes.
 */
export const createDefaultFreeDeviceReclaimer: FreeDeviceReclaimerFactory = ({
  registry,
  registryExists,
  pool,
  executions,
  timer,
  claimedBy,
}) => {
  if (process.env.NODE_ENV === "test") {
    return undefined;
  }
  return new FreeDeviceReclaimer({
    registry,
    registryExists,
    inventory: new DeviceManagerSlotInventory(new MultiPlatformDeviceManager()),
    claims: new PoolManagedSlotDeviceClaims(pool, executions),
    stopper: new PoolManagedSlotDeviceStopper(pool, defaultManagedSlotToolInvoker),
    isBusy: (device) => freeDeviceBusyReason(pool, device),
    claimedBy,
    timer,
  });
};
