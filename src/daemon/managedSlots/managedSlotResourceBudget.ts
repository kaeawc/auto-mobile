import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type {
  ManagedSlotCacheEvictor,
  ManagedSlotEvictionCandidate,
  ManagedSlotEvictionRegistry,
  ManagedSlotEvictionResult,
  ManagedSlotEvictionSelector,
  ManagedSlotEvictionSkip,
} from "./managedSlotCacheEviction";
import {
  isSlotJournalPhaseOpen,
  journalCreationPlatform,
  journalNewStableId,
  type FreeSlotDeviceRecord,
  type ManagedDeviceEntry,
  type SlotJournalEntry,
  type SlotPlatform,
  type SlotRegistry,
} from "./slotRegistry";

/** Owner-chosen numbers; nothing here has a built-in default except the LRU clock. */
export interface ManagedSlotResourceBudgetPolicy {
  /** Max distinct managed devices on this host across platforms and daemons; null = not enforced. */
  limit(): number | null;
}

/** Distinct registry commitments, independent of device power state. */
export interface ManagedSlotResourceUsage {
  /** Sum of the five categories, with one charge per distinct device. */
  total: number;
  /** Bound to a slot with a recorded execution session. */
  active: number;
  /** Bound, without an execution session, and not being deleted. */
  assignedIdle: number;
  /** Free-pool rows in free, stopping or stopped state. */
  cached: number;
  /** Unbound creation reservations, including anonymous replacement commitments. */
  preparing: number;
  /** Bound old devices named by an open replace in intent or deleting phase. */
  deleting: number;
}

/** Immediate admission evidence; unknown reads never imply free capacity. */
export type ManagedSlotResourceAdmission =
  | { kind: "admitted"; enforced: false }
  | {
      kind: "admitted";
      enforced: true;
      limit: number;
      usage: ManagedSlotResourceUsage;
      evicted: ManagedSlotEvictionCandidate[];
    }
  | {
      kind: "exhausted";
      limit: number;
      usage: ManagedSlotResourceUsage;
      /** Cached devices protected by the selector's safety checks. */
      retained: ManagedSlotEvictionSkip[];
      evictionFailures: Array<{ platform: SlotPlatform; stableDeviceId: string; message: string }>;
    }
  | { kind: "unknown"; message: string };

/** Admission for an already persisted creation reservation; no waiting or job queue. */
export interface ManagedSlotResourceBudget {
  /** Called after the creation's journal entry is open and before native creation. Never waits for capacity. */
  admitCreation(request: {
    journalEntryId: number;
    signal?: AbortSignal;
  }): Promise<ManagedSlotResourceAdmission>;
}

/** Ledger reads from the host-wide persistent registry. */
export type ManagedSlotResourceRegistry = Pick<
  SlotRegistry,
  "snapshotManagedDevices" | "listOpenSlotJournal" | "listFreeDevices"
>;

interface LedgerInput {
  openJournal: readonly SlotJournalEntry[];
  managed: readonly ManagedDeviceEntry[];
  /** Earlier free rows missing from the snapshot remain conservatively charged for this read. */
  freeBefore?: readonly FreeSlotDeviceRecord[];
}

interface ResourceCharge {
  category: Exclude<keyof ManagedSlotResourceUsage, "total">;
  journal?: SlotJournalEntry;
}

function resourceKey(platform: SlotPlatform, stableDeviceId: string): string {
  return JSON.stringify([platform, stableDeviceId]);
}

function creationJournalFor(
  device: ManagedDeviceEntry,
  journal: readonly SlotJournalEntry[],
): SlotJournalEntry | undefined {
  return journal.find(
    (entry) =>
      journalCreationPlatform(entry) === device.platform &&
      journalNewStableId(entry) === device.stableDeviceId,
  );
}

function chargeEarlierFreeRows(
  charges: ResourceCharge[],
  seen: Set<string>,
  rows: readonly FreeSlotDeviceRecord[],
): void {
  for (const row of rows) {
    const key = resourceKey(row.platform, row.stableDeviceId);
    if (!seen.has(key)) {
      charges.push({ category: "cached" });
      seen.add(key);
    }
  }
}

function categoryOf(
  device: ManagedDeviceEntry,
  deleting: ReadonlySet<string>,
): ResourceCharge["category"] {
  if (device.holder === "free") {
    return "cached";
  }
  if (device.scopeState === null) {
    return "preparing";
  }
  if (deleting.has(resourceKey(device.platform, device.stableDeviceId))) {
    return "deleting";
  }
  return device.execSessionUuid !== null ? "active" : "assignedIdle";
}

function resourceCharges(input: LedgerInput): ResourceCharge[] {
  const journal = input.openJournal.filter((entry) => isSlotJournalPhaseOpen(entry.phase));
  const deleting = new Set(
    journal
      .filter(
        (entry) =>
          entry.kind === "replace" &&
          ["intent", "deleting"].includes(entry.phase) &&
          entry.target.oldStableId !== null,
      )
      .map((entry) => resourceKey(entry.platform, entry.target.oldStableId!)),
  );
  const distinct = new Map(
    input.managed.map((device) => [resourceKey(device.platform, device.stableDeviceId), device]),
  );
  const seen = new Set(distinct.keys());
  const charges: ResourceCharge[] = [...distinct.values()].map((device) => ({
    category: categoryOf(device, deleting),
    journal: creationJournalFor(device, journal),
  }));
  chargeEarlierFreeRows(charges, seen, input.freeBefore ?? []);
  for (const entry of journal) {
    if (entry.kind === "release") {
      continue;
    }
    const newId = journalNewStableId(entry);
    if (newId !== null) {
      // If old and new are both visible, retain both charges conservatively.
      const key = resourceKey(journalCreationPlatform(entry), newId);
      if (!seen.has(key)) {
        charges.push({ category: "preparing", journal: entry });
        // Defensive deduplication also covers journal targets missing from the supplied snapshot.
        seen.add(key);
      }
    } else if (!hasOldDevice(entry, distinct)) {
      // `deleted` replacements have no new identity until `creating`. Pure abandoned deletes
      // carry the same fields: indistinguishable here, so charge until the entry closes (R4).
      charges.push({ category: "preparing", journal: entry });
    }
  }
  return charges;
}

function hasOldDevice(
  entry: SlotJournalEntry,
  distinct: ReadonlyMap<string, ManagedDeviceEntry>,
): boolean {
  return (
    entry.target.oldStableId !== null &&
    distinct.has(resourceKey(entry.platform, entry.target.oldStableId))
  );
}

function usageOf(charges: readonly ResourceCharge[]): ManagedSlotResourceUsage {
  const usage: ManagedSlotResourceUsage = {
    total: charges.length,
    active: 0,
    assignedIdle: 0,
    cached: 0,
    preparing: 0,
    deleting: 0,
  };
  for (const charge of charges) {
    usage[charge.category] += 1;
  }
  return usage;
}

/** Pure accounting: deduplicate devices and keep unresolved journal commitments charged. */
export function computeManagedSlotResourceUsage(input: LedgerInput): ManagedSlotResourceUsage {
  return usageOf(resourceCharges(input));
}

async function readResourceCharges(
  registry: ManagedSlotResourceRegistry,
): Promise<ResourceCharge[]> {
  // Journal first: a reservation committing between these reads is seen as its bound device.
  const firstJournal = await registry.listOpenSlotJournal();
  const freeBefore = await registry.listFreeDevices();
  const managed = await registry.snapshotManagedDevices();
  // Pre-reading free rows covers adoption during the snapshot, with a one-read over-count if
  // a row vanishes. A device BOTH freed (scope invalidation completes) and adopted between
  // this free read and the snapshot's own free read can still be missed. The wiring change
  // must require the registry snapshot to use one read transaction to close that residual.
  const unmatched = managed.some(
    (device) =>
      device.holder === "slot" &&
      device.scopeState === null &&
      creationJournalFor(device, firstJournal) === undefined,
  );
  let openJournal = firstJournal;
  if (unmatched) {
    const laterJournal = await registry.listOpenSlotJournal();
    // Retain first-read commitments; the later version wins for the same entry id.
    openJournal = [
      ...new Map([...firstJournal, ...laterJournal].map((entry) => [entry.id, entry])).values(),
    ];
  }
  return resourceCharges({ openJournal, freeBefore, managed });
}

function rankedCount(charges: readonly ResourceCharge[], mine: number): number {
  const charged = charges.filter(
    (charge) =>
      charge.category !== "preparing" ||
      charge.journal?.kind !== "create" ||
      charge.journal.id <= mine,
  );
  const containsMine = charged.some(
    (charge) => charge.category === "preparing" && charge.journal?.id === mine,
  );
  return charged.length + (containsMine ? 0 : 1);
}

interface BudgetDependencies {
  registry: () => Promise<ManagedSlotResourceRegistry & ManagedSlotEvictionRegistry>;
  policy: ManagedSlotResourceBudgetPolicy;
  /** Absent: nothing is ever evicted; a full budget is refused. */
  eviction?: { selector: ManagedSlotEvictionSelector; evictor: ManagedSlotCacheEvictor };
}

type ExhaustedAdmission = Extract<ManagedSlotResourceAdmission, { kind: "exhausted" }>;

/** Registry-derived admission with ordered reservations and conditional, bounded LRU eviction. */
export class RegistryManagedSlotResourceBudget implements ManagedSlotResourceBudget {
  constructor(private readonly deps: BudgetDependencies) {}

  async admitCreation(request: {
    journalEntryId: number;
    signal?: AbortSignal;
  }): Promise<ManagedSlotResourceAdmission> {
    const limit = this.deps.policy.limit();
    if (limit === null) {
      return { kind: "admitted", enforced: false };
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new ActionableError(
        "Managed-slot total-resource limit must be a positive safe integer or null; correct the budget policy.",
      );
    }
    try {
      const registry = await this.deps.registry();
      return await this.admitFromRegistry(registry, limit, request);
    } catch (error) {
      request.signal?.throwIfAborted();
      logger.warn(
        `[ManagedSlots] Resource admission could not read capacity: ${errorMessage(error)}`,
        error,
      );
      return { kind: "unknown", message: errorMessage(error) };
    }
  }

  private async admitFromRegistry(
    registry: ManagedSlotResourceRegistry & ManagedSlotEvictionRegistry,
    limit: number,
    request: { journalEntryId: number; signal?: AbortSignal },
  ): Promise<ManagedSlotResourceAdmission> {
    const evicted: ManagedSlotEvictionCandidate[] = [];
    const evictionFailures: ExhaustedAdmission["evictionFailures"] = [];
    const attempted = new Set<string>();
    let remaining: number | undefined;
    while (true) {
      request.signal?.throwIfAborted();
      const charges = await readResourceCharges(registry);
      const usage = usageOf(charges);
      if (rankedCount(charges, request.journalEntryId) <= limit) {
        return { kind: "admitted", enforced: true, limit, usage, evicted };
      }
      const exhausted: ExhaustedAdmission = {
        kind: "exhausted",
        limit,
        usage,
        retained: [],
        evictionFailures,
      };
      if (!this.deps.eviction) {
        return exhausted;
      }
      const selection = await this.deps.eviction.selector.select(registry, {
        signal: request.signal,
      });
      exhausted.retained = selection.skipped;
      // One attempt per initially observed free row, then one final read/selection iteration.
      remaining ??= selection.candidates.length + selection.skipped.length;
      const candidate = selection.candidates.find(
        (device) => !attempted.has(resourceKey(device.platform, device.stableDeviceId)),
      );
      if (!candidate || remaining === 0) {
        return exhausted;
      }
      remaining -= 1;
      request.signal?.throwIfAborted();
      attempted.add(resourceKey(candidate.platform, candidate.stableDeviceId));
      const result = await this.evict(candidate, request.signal);
      if (result.kind === "absent") {
        evicted.push(candidate);
      }
      if (result.kind === "failed") {
        evictionFailures.push({
          platform: candidate.platform,
          stableDeviceId: candidate.stableDeviceId,
          message: result.message,
        });
      }
    }
  }

  private async evict(
    candidate: ManagedSlotEvictionCandidate,
    signal?: AbortSignal,
  ): Promise<ManagedSlotEvictionResult> {
    try {
      return await this.deps.eviction!.evictor.evict(candidate, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(
        `[ManagedSlots] Cache deletion remains unconfirmed: ${errorMessage(error)}`,
        error,
      );
      return { kind: "failed", message: errorMessage(error) };
    }
  }
}
