import { MultiPlatformDeviceManager } from "../../devices/deviceUtils";
import type { Timer } from "../../utils/SystemTimer";
import type { DevicePool } from "../devicePool";
import { defaultManagedSlotToolInvoker } from "./daemonManagedSlotAcquisition";
import { freeDeviceBusyReason } from "./freeDeviceBusyReason";
import { FreeDeviceReclaimer } from "./freeDeviceReclaimer";
import { PoolManagedSlotDeviceStopper } from "./poolManagedSlotDeviceStopper";
import {
  DeviceManagerSlotInventory,
  PoolManagedSlotDeviceClaims,
} from "./managedSlotReconcilerPorts";
import type { LiveExecutionSessions } from "./slotOwnerLiveness";
import type { ManagedSlotJournal } from "./slotJournal";
import { JournaledManagedSlotCacheEvictor } from "./managedSlotCacheEviction";
import type { SlotRegistry } from "./slotRegistry";

/** What the daemon starts and stops; undefined means no sweep runs. */
export type FreeDeviceReclaimerHandle = Pick<FreeDeviceReclaimer, "start" | "stop">;

export type FreeDeviceReclaimerFactory = (deps: {
  registry: () => Promise<SlotRegistry>;
  journalFor?: (registry: SlotRegistry) => ManagedSlotJournal | undefined;
  /** False while the host registry does not exist; the sweep then never creates it. */
  registryExists: () => boolean;
  pool: DevicePool;
  executions: LiveExecutionSessions;
  timer: Timer;
  /** This daemon's id, recorded on its `stopping` claims. */
  claimedBy: string;
}) => FreeDeviceReclaimerHandle | undefined;

export { freeDeviceBusyReason, type FreeDeviceBusyPool } from "./freeDeviceBusyReason";

/**
 * The daemon's free-pool reclaim sweep (#11337): a device unadopted for an hour is shut down and
 * its image kept. Not armed under `bun test` (`NODE_ENV=test`): the host registry lives under the
 * real home directory, and a test daemon advancing a fake clock must never stop real devices.
 * Tests exercise {@link FreeDeviceReclaimer} directly with fakes.
 */
export const createDefaultFreeDeviceReclaimer: FreeDeviceReclaimerFactory = ({
  registry,
  registryExists,
  journalFor,
  pool,
  executions,
  timer,
  claimedBy,
}) => {
  if (process.env.NODE_ENV === "test") {
    return undefined;
  }
  let evictor: JournaledManagedSlotCacheEvictor | undefined;
  return new FreeDeviceReclaimer({
    registry: async () => {
      const resolved = await registry();
      evictor = createAbsentRowEvictor(resolved, journalFor);
      return resolved;
    },
    absentRowEvictor: () => evictor,
    registryExists,
    inventory: new DeviceManagerSlotInventory(new MultiPlatformDeviceManager()),
    claims: new PoolManagedSlotDeviceClaims(pool, executions),
    stopper: new PoolManagedSlotDeviceStopper(pool, defaultManagedSlotToolInvoker),
    isBusy: (device) => freeDeviceBusyReason(pool, device),
    claimedBy,
    timer,
  });
};

/** Resolve the acquisition journal lazily per sweep; discovery alone cannot release a row. */
export function createAbsentRowEvictor(
  registry: SlotRegistry,
  journalFor: ((registry: SlotRegistry) => ManagedSlotJournal | undefined) | undefined,
): JournaledManagedSlotCacheEvictor | undefined {
  const journal = journalFor?.(registry);
  return journal ? new JournaledManagedSlotCacheEvictor(registry, () => journal) : undefined;
}
