import type { Timer } from "../../utils/SystemTimer";
import {
  AbandonedScopeReclaimer,
  type AbandonedScopeReclaimJournal,
  type AbandonedScopeReclaimRegistry,
} from "./abandonedScopeReclaimer";
import type { SlotRegistry } from "./slotRegistry";

/** What the daemon starts and stops; undefined means no sweep runs. */
export type ManagedSlotReclaimerHandle = Pick<AbandonedScopeReclaimer, "start" | "stop">;

export type ManagedSlotReclaimerFactory = (deps: {
  registry: () => Promise<SlotRegistry>;
  /** False while the host registry does not exist; the sweep then never creates it. */
  registryExists: () => boolean;
  /**
   * The slot journal (#11179) the sweep deletes through. Undefined while this daemon has no device
   * inventory and claim ports for the journal: the sweep is then not armed.
   */
  journal: ((registry: AbandonedScopeReclaimRegistry) => AbandonedScopeReclaimJournal) | undefined;
  timer: Timer;
}) => ManagedSlotReclaimerHandle | undefined;

/**
 * The daemon's abandoned-scope sweep (#11174). Not armed under `bun test` (`NODE_ENV=test`): the
 * host registry lives under the real home directory, and a test daemon advancing a fake clock must
 * never delete real devices. Tests exercise {@link AbandonedScopeReclaimer} directly with fakes.
 */
export const createDefaultAbandonedScopeReclaimer: ManagedSlotReclaimerFactory = ({
  registry,
  registryExists,
  journal,
  timer,
}) => {
  if (process.env.NODE_ENV === "test" || journal === undefined) {
    return undefined;
  }
  return new AbandonedScopeReclaimer({ registry, registryExists, journal, timer });
};
