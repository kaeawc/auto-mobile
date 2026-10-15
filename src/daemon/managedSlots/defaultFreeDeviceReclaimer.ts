import { MultiPlatformDeviceManager } from "../../devices/deviceUtils";
import type { Timer } from "../../utils/SystemTimer";
import type { DevicePool } from "../devicePool";
import { defaultBindingToolInvoker } from "../sessionBroker/provisioning/daemonDeviceAcquisition";
import { freeDeviceBusyReason } from "../sessionBroker/provisioning/freeDeviceBusyReason";
import { FreeDeviceReclaimer } from "./freeDeviceReclaimer";
import { PoolManagedSlotDeviceStopper } from "./poolManagedSlotDeviceStopper";
import {
  DeviceManagerBindingInventory,
  PoolBindingDeviceClaims,
} from "../sessionBroker/provisioning/reconcilerPorts";
import type { LiveExecutionSessions } from "../sessionBroker/registry/ownerLiveness";
import type { BindingJournal } from "../sessionBroker/registry/bindingJournal";
import { JournaledBindingCacheEvictor } from "../sessionBroker/provisioning/cacheEviction";
import type { BindingRegistry } from "../sessionBroker/registry/bindingRegistry";

/** What the daemon starts and stops; undefined means no sweep runs. */
export type FreeDeviceReclaimerHandle = Pick<FreeDeviceReclaimer, "start" | "stop">;

export type FreeDeviceReclaimerFactory = (deps: {
  registry: () => Promise<BindingRegistry>;
  journalFor?: (registry: BindingRegistry) => BindingJournal | undefined;
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
  let evictor: JournaledBindingCacheEvictor | undefined;
  return new FreeDeviceReclaimer({
    registry: async () => {
      const resolved = await registry();
      evictor = createAbsentRowEvictor(resolved, journalFor);
      return resolved;
    },
    absentRowEvictor: () => evictor,
    registryExists,
    inventory: new DeviceManagerBindingInventory(new MultiPlatformDeviceManager()),
    claims: new PoolBindingDeviceClaims(pool, executions),
    stopper: new PoolManagedSlotDeviceStopper(pool, defaultBindingToolInvoker),
    isBusy: (device) => freeDeviceBusyReason(pool, device),
    claimedBy,
    timer,
  });
};

/** Resolve the acquisition journal lazily per sweep; discovery alone cannot release a row. */
export function createAbsentRowEvictor(
  registry: BindingRegistry,
  journalFor: ((registry: BindingRegistry) => BindingJournal | undefined) | undefined,
): JournaledBindingCacheEvictor | undefined {
  const journal = journalFor?.(registry);
  return journal ? new JournaledBindingCacheEvictor(registry, () => journal) : undefined;
}
