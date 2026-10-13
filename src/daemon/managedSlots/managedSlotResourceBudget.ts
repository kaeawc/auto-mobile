import { parseStrictPositiveInteger } from "../../utils/envNumbers";
import { MANAGED_SLOT_DEVICE_NAME_PREFIX, type ManagedSlotInventory } from "./reconciler";
import { deviceStableId } from "./slotDeviceIdentity";
import type { DeviceInfo } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { ManagedSlotBudgetEvidence } from "../../models/managedSlotsResult";
import {
  isStuckFreeDeviceDeletion,
  managedSlotDeletionSkip,
  uncountedStuckFreeDeviceDeletions,
  type ManagedSlotCacheEvictor,
  type ManagedSlotEvictionCandidate,
  type ManagedSlotEvictionRegistry,
  type ManagedSlotEvictionResult,
  type ManagedSlotEvictionSelector,
  type ManagedSlotEvictionSkip,
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

/** Host-wide total-resource policy, independent of boot admission. */
export const MANAGED_SLOT_MAX_DEVICES_ENV = "AUTOMOBILE_MANAGED_SLOT_MAX_DEVICES";

export function parseManagedSlotMaxDevices(env: NodeJS.ProcessEnv = process.env): number | null {
  const value = env[MANAGED_SLOT_MAX_DEVICES_ENV];
  if (value === undefined || value === "") {
    return null;
  }
  const limit = parseStrictPositiveInteger(value);
  if (limit !== undefined) {
    return limit;
  }
  logger.warn(
    `[ManagedSlots] Invalid ${MANAGED_SLOT_MAX_DEVICES_ENV}=${JSON.stringify(value)}; total-resource budget is not enforced.`,
  );
  return null;
}

/** Owner-chosen numbers; nothing here has a built-in default except the LRU clock. */
export interface ManagedSlotResourceBudgetPolicy {
  /** Max distinct managed devices on this host across platforms and daemons; null = not enforced. */
  limit(): number | null;
}

/** Distinct registry commitments, independent of device power state. */
export interface ManagedSlotResourceUsage {
  /** Sum of all categories, with one charge per distinct device. */
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
  /** Daemon-named inventory devices without a registry commitment. */
  orphaned: number;
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
  | ({ kind: "exhausted" } & ManagedSlotBudgetEvidence)
  | { kind: "unknown"; message: string };

/** Admission for an already persisted creation reservation; no waiting or job queue. */
export interface ManagedSlotResourceBudget {
  /** Called after the creation's journal entry is open and before native creation. Never waits for capacity. */
  admitCreation(request: {
    journalEntryId: number;
    deadlineMs?: number;
    signal?: AbortSignal;
  }): Promise<ManagedSlotResourceAdmission>;
}

/** Ledger reads from the host-wide persistent registry. */
export type ManagedSlotResourceRegistry = Pick<SlotRegistry, "snapshotManagedSlotResources">;

interface LedgerInput {
  openJournal: readonly SlotJournalEntry[];
  managed: readonly ManagedDeviceEntry[];
  free?: readonly FreeSlotDeviceRecord[];
  abandonedScopeKeys?: readonly string[];
  inventory?: readonly DeviceInfo[];
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

function categoryOf(
  device: ManagedDeviceEntry,
  deleting: ReadonlySet<string>,
  free: readonly FreeSlotDeviceRecord[],
): ResourceCharge["category"] {
  if (device.holder === "free") {
    return free.some(
      (row) =>
        row.platform === device.platform &&
        row.stableDeviceId === device.stableDeviceId &&
        row.deletion !== null,
    )
      ? "deleting"
      : "cached";
  }
  if (device.scopeState === null) {
    return "preparing";
  }
  if (deleting.has(resourceKey(device.platform, device.stableDeviceId))) {
    return "deleting";
  }
  return device.execSessionUuid !== null ? "active" : "assignedIdle";
}

function chargeManagedDevice(
  device: ManagedDeviceEntry,
  deleting: ReadonlySet<string>,
  free: readonly FreeSlotDeviceRecord[],
  journal: readonly SlotJournalEntry[],
  uncounted: readonly FreeSlotDeviceRecord[],
): ResourceCharge[] {
  if (
    device.holder === "free" &&
    uncounted.some(
      (row) => row.platform === device.platform && row.stableDeviceId === device.stableDeviceId,
    )
  ) {
    return [];
  }
  return [
    { category: categoryOf(device, deleting, free), journal: creationJournalFor(device, journal) },
  ];
}

function resourceCharges(input: LedgerInput): ResourceCharge[] {
  const journal = input.openJournal.filter((entry) => isSlotJournalPhaseOpen(entry.phase));
  const uncounted = uncountedStuckFreeDeviceDeletions(
    input.free ?? [],
    input.managed.filter((device) => device.holder === "slot"),
  );
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
    input.managed
      .filter(
        (device) =>
          !journal.some(
            (entry) =>
              entry.kind === "create" &&
              device.holder === "slot" &&
              device.scopeState !== null &&
              entry.scopeKey === device.scopeKey &&
              entry.slotIndex === device.slotIndex &&
              journalNewStableId(entry) !== device.stableDeviceId,
          ),
      )
      .map((device) => [resourceKey(device.platform, device.stableDeviceId), device]),
  );
  const seen = new Set(distinct.keys());
  const charges = [...distinct.values()].flatMap((device) =>
    chargeManagedDevice(device, deleting, input.free ?? [], journal, uncounted),
  );

  for (const entry of journal) {
    if (
      entry.kind === "release" ||
      (entry.kind === "replace" &&
        entry.phase === "deleted" &&
        input.abandonedScopeKeys?.includes(entry.scopeKey))
    ) {
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
      // A genuine replacement keeps its continuous reservation after verified deletion.
      charges.push({ category: "preparing", journal: entry });
    }
  }
  chargeOrphans(input, charges, seen);
  return charges;
}

function chargeOrphans(input: LedgerInput, charges: ResourceCharge[], seen: Set<string>): void {
  for (const device of input.inventory ?? []) {
    const stableId = deviceStableId(device);
    if (!stableId || !device.name.startsWith(MANAGED_SLOT_DEVICE_NAME_PREFIX)) {
      continue;
    }
    const key = resourceKey(device.platform, stableId);
    const known =
      input.managed.some((entry) => resourceKey(entry.platform, entry.stableDeviceId) === key) ||
      input.openJournal.some(
        (entry) =>
          (entry.platform === device.platform &&
            [entry.target.oldStableId, entry.target.oldName].some(
              (id) => id === stableId || id === device.name,
            )) ||
          (journalCreationPlatform(entry) === device.platform &&
            [entry.target.newStableId, entry.target.newName].some(
              (id) => id === stableId || id === device.name,
            )),
      );
    if (!known && !seen.has(key)) {
      charges.push({ category: "orphaned" });
      seen.add(key);
    }
  }
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
    orphaned: 0,
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
  inventory: ManagedSlotInventory,
  request: { signal?: AbortSignal; deadlineMs?: number },
  timer: Pick<Timer, "now">,
): Promise<{ charges: ResourceCharge[]; retained: ManagedSlotEvictionSkip[] }> {
  checkAdmissionBudget(request, timer);
  const snapshot = await registry.snapshotManagedSlotResources();
  const devices: DeviceInfo[] = [];
  for (const platform of ["android", "ios"] as const) {
    checkAdmissionBudget(request, timer);
    const listing = await inventory.list(platform, { signal: request.signal });
    if (!listing.complete && listing.toolchain === "not_installed") {
      continue;
    }
    if (!listing.complete) {
      throw new ActionableError(
        `${platform} inventory is incomplete; total-resource usage is unknown.`,
      );
    }
    devices.push(...listing.devices);
  }
  const uncounted = uncountedStuckFreeDeviceDeletions(
    snapshot.free,
    snapshot.managed.filter((device) => device.holder === "slot"),
  );
  return {
    charges: resourceCharges({ ...snapshot, inventory: devices }),
    retained: snapshot.free.flatMap((row) => {
      const skip = managedSlotDeletionSkip(row, uncounted.includes(row));
      return skip ? [skip] : [];
    }),
  };
}

function checkAdmissionBudget(
  request: { signal?: AbortSignal; deadlineMs?: number },
  timer: Pick<Timer, "now">,
): void {
  request.signal?.throwIfAborted();
  if (request.deadlineMs !== undefined && timer.now() >= request.deadlineMs) {
    throw new ActionableError(
      "Managed-slot preparation deadline passed during resource admission.",
    );
  }
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
  inventory: ManagedSlotInventory;
  timer?: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  /** Absent: nothing is ever evicted; a full budget is refused. */
  eviction?: { selector: ManagedSlotEvictionSelector; evictor: ManagedSlotCacheEvictor };
}

type ExhaustedAdmission = Extract<ManagedSlotResourceAdmission, { kind: "exhausted" }>;

/** Registry-derived admission with ordered reservations and conditional, bounded LRU eviction. */
export class RegistryManagedSlotResourceBudget implements ManagedSlotResourceBudget {
  private readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;

  constructor(private readonly deps: BudgetDependencies) {
    this.timer = deps.timer ?? defaultTimer;
  }

  async admitCreation(request: {
    journalEntryId: number;
    deadlineMs?: number;
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
      checkAdmissionBudget(request, this.timer);
      const admission = async () =>
        this.admitFromRegistry(await this.deps.registry(), limit, request);
      return request.deadlineMs === undefined
        ? await admission()
        : await raceWithDeadline(admission, {
            timer: this.timer,
            timeoutMs: Math.max(0, request.deadlineMs - this.timer.now()),
            signal: request.signal,
            label: "Managed-slot resource admission",
          });
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
    request: { journalEntryId: number; deadlineMs?: number; signal?: AbortSignal },
  ): Promise<ManagedSlotResourceAdmission> {
    const evicted: ManagedSlotEvictionCandidate[] = [];
    const evictionFailures: ExhaustedAdmission["evictionFailures"] = [];
    const attempted = new Set<string>();
    let remaining: number | undefined;
    while (true) {
      let ledger = await readResourceCharges(registry, this.deps.inventory, request, this.timer);
      if (rankedCount(ledger.charges, request.journalEntryId) > limit) {
        // Confirm with a fresh independent snapshot before eviction or refusal.
        ledger = await readResourceCharges(registry, this.deps.inventory, request, this.timer);
      }
      const { charges, retained } = ledger;
      const usage = usageOf(charges);
      if (rankedCount(charges, request.journalEntryId) <= limit) {
        return { kind: "admitted", enforced: true, limit, usage, evicted };
      }
      const exhausted: ExhaustedAdmission = {
        kind: "exhausted",
        limit,
        usage,
        retained,
        evictionFailures,
      };
      // Counted markers commit room while native deletion redrives; stuck markers do not.
      const shortfall = rankedCount(charges, request.journalEntryId) - limit;
      if (
        !this.deps.eviction ||
        retained.filter((row) => !isStuckFreeDeviceDeletion(row)).length >= shortfall
      ) {
        return exhausted;
      }
      checkAdmissionBudget(request, this.timer);
      const selection = await this.deps.eviction.selector.select(registry, {
        signal: request.signal,
        deadlineMs: request.deadlineMs,
      });
      exhausted.retained = selection.skipped.map(({ uncounted: _uncounted, ...row }) => ({
        ...row,
        ...(retained.some(
          (marker) =>
            marker.platform === row.platform &&
            marker.stableDeviceId === row.stableDeviceId &&
            marker.uncounted,
        )
          ? { uncounted: true as const }
          : {}),
      }));
      // One attempt per initially observed free row, then one final read/selection iteration.
      remaining ??= selection.candidates.length + selection.skipped.length;
      const candidate = selection.candidates.find(
        (device) => !attempted.has(resourceKey(device.platform, device.stableDeviceId)),
      );
      if (!candidate || remaining === 0) {
        return exhausted;
      }
      remaining -= 1;
      checkAdmissionBudget(request, this.timer);
      attempted.add(resourceKey(candidate.platform, candidate.stableDeviceId));
      const result = await this.evict(candidate, request);
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
    options: { signal?: AbortSignal; deadlineMs?: number },
  ): Promise<ManagedSlotEvictionResult> {
    try {
      return await this.deps.eviction!.evictor.evict(candidate, options);
    } catch (error) {
      options.signal?.throwIfAborted();
      logger.warn(
        `[ManagedSlots] Cache deletion remains unconfirmed: ${errorMessage(error)}`,
        error,
      );
      return { kind: "failed", message: errorMessage(error) };
    }
  }
}
