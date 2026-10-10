import { MultiPlatformDeviceManager } from "../../devices/deviceUtils";
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
}) => FreeDeviceReclaimerHandle | undefined;

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
    isBusy: (device) => {
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
      return pool.isUnderShutdownReservation(runtime.id) ||
        pool.isDeviceLeasedForAndroidStartup(runtime.id)
        ? "lifecycle operation in flight"
        : undefined;
    },
    timer,
  });
};
