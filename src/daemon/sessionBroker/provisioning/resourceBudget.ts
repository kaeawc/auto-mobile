import type { BindingInventory } from "./reconciler";
import { isProductBrokerDevice, LEGACY_DEVICE_NAME_PREFIX } from "../persistedIdentity";
import { deviceStableId } from "../registry/deviceIdentity";
import type { DeviceInfo } from "../../../models/index";
import { ActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import type { BindingBudgetEvidence } from "./acquisitionResult";
import {
  isBindingJournalPhaseOpen,
  journalCreationPlatform,
  journalNewStableId,
  type ManagedDeviceEntry,
  type BindingJournalEntry,
  type BindingPlatform,
  type BindingRegistry,
} from "../registry/bindingRegistry";

/** Operator limits supplied by the broker host configuration. */
export interface BindingResourceBudgetPolicy {
  /** Max distinct managed devices across platforms; zero refuses creation, null = not enforced. */
  limit(): number | null;
}

/** Distinct registry commitments, independent of device power state. */
export interface BindingResourceUsage {
  /** Sum of all categories, with one charge per distinct device. */
  total: number;
  /** Bound to a binding with a recorded execution session. */
  active: number;
  /** Bound, without an execution session, and not being deleted. */
  assignedIdle: number;
  /** Unbound creation reservations, including anonymous replacement commitments. */
  preparing: number;
  /** Bound old devices named by an open replace in intent or deleting phase. */
  deleting: number;
  /** Daemon-named inventory devices without a registry commitment. */
  orphaned: number;
}

/** Immediate admission evidence; unknown reads never imply free capacity. */
export type BindingResourceAdmission =
  | { kind: "admitted"; enforced: false }
  | {
      kind: "admitted";
      enforced: true;
      limit: number;
      usage: BindingResourceUsage;
      evicted: never[];
    }
  | ({ kind: "exhausted" } & BindingBudgetEvidence)
  | { kind: "unknown"; message: string };

/** Admission for an already persisted creation reservation; no waiting or job queue. */
export interface BindingResourceBudget {
  /** Called after the creation's journal entry is open and before native creation. Never waits for capacity. */
  admitCreation(request: {
    journalEntryId: number;
    deadlineMs?: number;
    signal?: AbortSignal;
  }): Promise<BindingResourceAdmission>;
}

/** Ledger reads from the host-wide persistent registry. */
export type BindingResourceRegistry = Pick<BindingRegistry, "snapshotBindingResources">;

interface LedgerInput {
  openJournal: readonly BindingJournalEntry[];
  managed: readonly ManagedDeviceEntry[];
  inventory?: readonly DeviceInfo[];
}

interface ResourceCharge {
  category: Exclude<keyof BindingResourceUsage, "total">;
  platform: BindingPlatform;
  stableDeviceId: string;
  journal?: BindingJournalEntry;
}

type ChargedEvidence = BindingBudgetEvidence["charged"][number];

const chargeKindOrder: ChargedEvidence["kind"][] = [
  "assigned_active",
  "assigned_idle",
  "deleting",
  "preparing",
  "orphaned",
];

function chargedEvidence(charges: readonly ResourceCharge[]): ChargedEvidence[] {
  const kindFor: Record<ResourceCharge["category"], ChargedEvidence["kind"]> = {
    active: "assigned_active",
    assignedIdle: "assigned_idle",
    deleting: "deleting",
    preparing: "preparing",
    orphaned: "orphaned",
  };
  return charges
    .map((charge) => ({
      platform: charge.platform,
      stableDeviceId: charge.stableDeviceId,
      kind: kindFor[charge.category],
    }))
    .sort(
      (a, b) =>
        chargeKindOrder.indexOf(a.kind) - chargeKindOrder.indexOf(b.kind) ||
        a.platform.localeCompare(b.platform) ||
        a.stableDeviceId.localeCompare(b.stableDeviceId),
    );
}

function resourceKey(platform: BindingPlatform, stableDeviceId: string): string {
  return JSON.stringify([platform, stableDeviceId]);
}

function creationJournalFor(
  device: ManagedDeviceEntry,
  journal: readonly BindingJournalEntry[],
): BindingJournalEntry | undefined {
  return journal.find(
    (entry) =>
      journalCreationPlatform(entry) === device.platform &&
      journalNewStableId(entry) === device.stableDeviceId,
  );
}

function categoryOf(
  device: ManagedDeviceEntry,
  deleting: ReadonlySet<string>,
): ResourceCharge["category"] {
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
  journal: readonly BindingJournalEntry[],
): ResourceCharge[] {
  return [
    {
      category: categoryOf(device, deleting),
      platform: device.platform,
      stableDeviceId: device.stableDeviceId,
      journal: creationJournalFor(device, journal),
    },
  ];
}

function addPreparingJournalCharge(charges: ResourceCharge[], entry: BindingJournalEntry): void {
  const stableDeviceId =
    journalNewStableId(entry) ??
    entry.target.newName ??
    entry.target.oldStableId ??
    entry.target.oldName;
  if (!stableDeviceId) {
    return;
  }
  charges.push({
    category: "preparing",
    platform: journalCreationPlatform(entry),
    stableDeviceId,
    journal: entry,
  });
}

function resourceCharges(input: LedgerInput): ResourceCharge[] {
  const journal = input.openJournal.filter((entry) => isBindingJournalPhaseOpen(entry.phase));
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
              device.holder === "session_broker" &&
              device.scopeState !== null &&
              entry.scopeKey === device.scopeKey &&
              entry.bindingIndex === device.bindingIndex &&
              journalNewStableId(entry) !== device.stableDeviceId,
          ),
      )
      .map((device) => [resourceKey(device.platform, device.stableDeviceId), device]),
  );
  const seen = new Set(distinct.keys());
  const charges = [...distinct.values()].flatMap((device) =>
    chargeManagedDevice(device, deleting, journal),
  );

  for (const entry of journal) {
    if (entry.kind === "release") {
      continue;
    }
    const newId = journalNewStableId(entry);
    if (newId !== null) {
      // If old and new are both visible, retain both charges conservatively.
      const key = resourceKey(journalCreationPlatform(entry), newId);
      if (!seen.has(key)) {
        addPreparingJournalCharge(charges, entry);
        // Defensive deduplication also covers journal targets missing from the supplied snapshot.
        seen.add(key);
      }
    } else if (!hasOldDevice(entry, distinct)) {
      // A genuine replacement keeps its continuous reservation after verified deletion.
      addPreparingJournalCharge(charges, entry);
    }
  }
  chargeOrphans(input, charges, seen);
  return charges;
}

function chargeOrphans(input: LedgerInput, charges: ResourceCharge[], seen: Set<string>): void {
  for (const device of input.inventory ?? []) {
    const stableId = deviceStableId(device);
    if (!stableId || !isProductBrokerDevice(device.name)) {
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
    if (!known && !seen.has(key) && !device.name.startsWith(LEGACY_DEVICE_NAME_PREFIX)) {
      charges.push({ category: "orphaned", platform: device.platform, stableDeviceId: stableId });
      seen.add(key);
    }
  }
}

function hasOldDevice(
  entry: BindingJournalEntry,
  distinct: ReadonlyMap<string, ManagedDeviceEntry>,
): boolean {
  return (
    entry.target.oldStableId !== null &&
    distinct.has(resourceKey(entry.platform, entry.target.oldStableId))
  );
}

function usageOf(charges: readonly ResourceCharge[]): BindingResourceUsage {
  const usage: BindingResourceUsage = {
    total: charges.length,
    active: 0,
    assignedIdle: 0,
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
export function computeBindingResourceUsage(input: LedgerInput): BindingResourceUsage {
  return usageOf(resourceCharges(input));
}

async function readResourceCharges(
  registry: BindingResourceRegistry,
  inventory: BindingInventory,
  request: { signal?: AbortSignal; deadlineMs?: number },
  timer: Pick<Timer, "now">,
): Promise<{
  charges: ResourceCharge[];
  charged: ChargedEvidence[];
}> {
  checkAdmissionBudget(request, timer);
  const snapshot = await registry.snapshotBindingResources();
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
  const charges = resourceCharges({ ...snapshot, inventory: devices });
  return {
    charges,
    charged: chargedEvidence(charges),
  };
}

function checkAdmissionBudget(
  request: { signal?: AbortSignal; deadlineMs?: number },
  timer: Pick<Timer, "now">,
): void {
  request.signal?.throwIfAborted();
  if (request.deadlineMs !== undefined && timer.now() >= request.deadlineMs) {
    throw new ActionableError(
      "Managed-binding preparation deadline passed during resource admission.",
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
  registry: () => Promise<BindingResourceRegistry>;
  policy: BindingResourceBudgetPolicy;
  inventory: BindingInventory;
  timer?: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
}

/** Registry-derived admission with ordered reservations and no automatic eviction. */
export class RegistryBindingResourceBudget implements BindingResourceBudget {
  private readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;

  constructor(private readonly deps: BudgetDependencies) {
    this.timer = deps.timer ?? defaultTimer;
  }

  async admitCreation(request: {
    journalEntryId: number;
    deadlineMs?: number;
    signal?: AbortSignal;
  }): Promise<BindingResourceAdmission> {
    const limit = this.deps.policy.limit();
    if (limit === null) {
      return { kind: "admitted", enforced: false };
    }
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new ActionableError(
        "Managed-binding total-resource limit must be a nonnegative safe integer or null; correct the budget policy.",
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
            label: "Managed-binding resource admission",
          });
    } catch (error) {
      request.signal?.throwIfAborted();
      logger.warn(
        `[Bindings] Resource admission could not read capacity: ${errorMessage(error)}`,
        error,
      );
      return { kind: "unknown", message: errorMessage(error) };
    }
  }

  private async admitFromRegistry(
    registry: BindingResourceRegistry,
    limit: number,
    request: { journalEntryId: number; deadlineMs?: number; signal?: AbortSignal },
  ): Promise<BindingResourceAdmission> {
    let ledger = await readResourceCharges(registry, this.deps.inventory, request, this.timer);
    if (rankedCount(ledger.charges, request.journalEntryId) > limit) {
      ledger = await readResourceCharges(registry, this.deps.inventory, request, this.timer);
    }
    const usage = usageOf(ledger.charges);
    return rankedCount(ledger.charges, request.journalEntryId) <= limit
      ? { kind: "admitted", enforced: true, limit, usage, evicted: [] }
      : {
          kind: "exhausted",
          limit,
          usage,
          charged: ledger.charged,
          retained: [],
          evictionFailures: [],
        };
  }
}
