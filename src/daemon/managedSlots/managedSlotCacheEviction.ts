import type { DeviceInfo } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { ActionableError } from "../../models/ActionableError";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { ManagedSlotJournal } from "./slotJournal";
import {
  MANAGED_SLOT_DEVICE_NAME_PREFIX,
  type ManagedSlotDeviceClaims,
  type ManagedSlotInventory,
} from "./reconciler";
import { deviceStableId } from "./slotDeviceIdentity";
import {
  journalNamesFreeDevice,
  type FreeSlotDeviceRecord,
  type SlotJournalEntry,
  type SlotPlatform,
  type SlotRegistry,
} from "./slotRegistry";

/** Exact free-pool row offered for a journaled deletion. */
export interface ManagedSlotEvictionCandidate {
  platform: SlotPlatform;
  stableDeviceId: string;
  name: string;
  fromScopeKey: string;
  freedAtMs: number;
  lastUsedAtMs: number;
}

/** A cached device left alone and the safety check that protected it. */
export interface ManagedSlotEvictionSkip {
  platform: SlotPlatform;
  stableDeviceId: string;
  reason: string;
}

/** Read-only registry surface needed to select cache entries. */
export type ManagedSlotEvictionRegistry = Pick<
  SlotRegistry,
  "listFreeDevices" | "findDeviceHolder" | "listOpenSlotJournal"
>;

/** Eligible cache in LRU order, plus every protected cache row. */
export interface ManagedSlotEvictionSelection {
  candidates: ManagedSlotEvictionCandidate[];
  skipped: ManagedSlotEvictionSkip[];
}

/** Selection never mutates the registry or a native device. */
export interface ManagedSlotEvictionSelector {
  select(
    registry: ManagedSlotEvictionRegistry,
    options: { signal?: AbortSignal; deadlineMs?: number },
  ): Promise<ManagedSlotEvictionSelection>;
}

/** Only verified absence releases a charge; a failed deletion remains journaled for redrive. */
export type ManagedSlotEvictionResult =
  /** Delete journaled, absence verified and free row removed. */
  | { kind: "absent" }
  /** Adopted, re-freed or claimed meanwhile; nothing was deleted. */
  | { kind: "lost" }
  /** Journaled but unconfirmed: stays charged and redrive retries it. */
  | { kind: "failed"; message: string };

/**
 * The journaled evictor records the delete on the host-wide free row BEFORE any
 * native deletion, guarded by a compare-and-set on the exact free-pool row (platform,
 * stableDeviceId, fromScopeKey, freedAtMs) so a concurrent adoption wins. Answer `absent` only
 * after verified absence and removal of the free row. A journaled delete always completes or
 * is retried by journal redrive. Never delete a device that is not a free-pool row at the CAS.
 * Recheck holds, live executions, restart reservations and acquisition/lifecycle work before
 * deletion: selection is an observation, not authority to bypass these safety checks.
 */
export interface ManagedSlotCacheEvictor {
  evict(
    candidate: ManagedSlotEvictionCandidate,
    options: { signal?: AbortSignal; deadlineMs?: number },
  ): Promise<ManagedSlotEvictionResult>;
}

interface EvictionSelectorDependencies {
  inventory: ManagedSlotInventory;
  claims: Pick<ManagedSlotDeviceClaims, "describe" | "sessionsOn">;
  timer?: Pick<Timer, "now">;
  /** In-flight boot, lifecycle lease, shutdown or restart-recovery reservation; absent when quiet. */
  isBusy?: (device: DeviceInfo) => string | undefined;
  /** Default LRU clock is the persisted free-pool row's freedAtMs. */
  lastUsedAtMs?: (device: FreeSlotDeviceRecord) => number;
}

/** Select only unassigned, fully discovered and quiet daemon-created cache entries. */
export class DefaultManagedSlotEvictionSelector implements ManagedSlotEvictionSelector {
  constructor(private readonly deps: EvictionSelectorDependencies) {}

  async select(
    registry: ManagedSlotEvictionRegistry,
    options: { signal?: AbortSignal; deadlineMs?: number },
  ): Promise<ManagedSlotEvictionSelection> {
    this.checkBudget(options);
    const rows = await registry.listFreeDevices();
    this.checkBudget(options);
    const journal = await registry.listOpenSlotJournal();
    const listings = new Map<SlotPlatform, DeviceInfo[] | undefined>();
    const selection: ManagedSlotEvictionSelection = { candidates: [], skipped: [] };
    for (const row of rows) {
      this.checkBudget(options);
      if (!listings.has(row.platform)) {
        listings.set(row.platform, await this.list(row.platform, options));
      }
      this.checkBudget(options);
      const result = await this.checkRow(
        registry,
        row,
        journal,
        listings.get(row.platform),
        options,
      );
      if (typeof result === "string") {
        selection.skipped.push({
          platform: row.platform,
          stableDeviceId: row.stableDeviceId,
          reason: result,
        });
      } else {
        selection.candidates.push({
          platform: row.platform,
          stableDeviceId: row.stableDeviceId,
          name: result.name,
          fromScopeKey: row.fromScopeKey,
          freedAtMs: row.freedAtMs,
          lastUsedAtMs: this.deps.lastUsedAtMs?.(row) ?? row.freedAtMs,
        });
      }
    }
    selection.candidates.sort(
      (a, b) =>
        a.lastUsedAtMs - b.lastUsedAtMs ||
        compareText(a.platform, b.platform) ||
        compareText(a.stableDeviceId, b.stableDeviceId),
    );
    return selection;
  }

  private checkBudget(options: { signal?: AbortSignal; deadlineMs?: number }): void {
    options.signal?.throwIfAborted();
    if (
      options.deadlineMs !== undefined &&
      (this.deps.timer ?? defaultTimer).now() >= options.deadlineMs
    ) {
      throw new ActionableError("Managed-slot preparation deadline passed during cache selection.");
    }
  }

  private async list(
    platform: SlotPlatform,
    options: { signal?: AbortSignal },
  ): Promise<DeviceInfo[] | undefined> {
    try {
      const listing = await this.deps.inventory.list(platform, options);
      return listing.complete ? listing.devices : undefined;
    } catch (error) {
      options.signal?.throwIfAborted();
      logger.warn(`[ManagedSlots] Cache eviction discovery failed: ${errorMessage(error)}`, error);
      return undefined;
    }
  }

  private async checkRow(
    registry: ManagedSlotEvictionRegistry,
    row: FreeSlotDeviceRecord,
    journal: readonly SlotJournalEntry[],
    listing: DeviceInfo[] | undefined,
    options: { signal?: AbortSignal; deadlineMs?: number },
  ): Promise<string | DeviceInfo> {
    if (row.deletion !== null) {
      return "deletion_pending";
    }
    if (row.state === "stopping") {
      return "stopping";
    }
    if (journal.some((entry) => journalNamesFreeDevice(entry, row))) {
      return "journal_open";
    }
    const device = this.listedDevice(row, journal, listing);
    if (typeof device === "string") {
      return device;
    }
    const reason = await this.holdReason(device);
    if (reason) {
      return reason;
    }
    this.checkBudget(options);
    const holder = await registry.findDeviceHolder(row.platform, row.stableDeviceId);
    if (holder?.kind !== "free") {
      return "row_moved";
    }
    return holder.device.freedAtMs === row.freedAtMs &&
      holder.device.fromScopeKey === row.fromScopeKey
      ? device
      : "row_moved";
  }

  private listedDevice(
    row: FreeSlotDeviceRecord,
    journal: readonly SlotJournalEntry[],
    listing: DeviceInfo[] | undefined,
  ): string | DeviceInfo {
    if (!listing) {
      return "discovery_incomplete";
    }
    const device = listing.find(
      (entry) => entry.platform === row.platform && deviceStableId(entry) === row.stableDeviceId,
    );
    if (!device) {
      return "not_in_inventory";
    }
    if (journal.some((entry) => journalNamesFreeDevice(entry, { ...row, name: device.name }))) {
      return "journal_open";
    }
    if (!device.name.startsWith(MANAGED_SLOT_DEVICE_NAME_PREFIX)) {
      return "not_daemon_created";
    }
    return device;
  }

  private async holdReason(device: DeviceInfo): Promise<string | undefined> {
    if ((this.deps.claims.sessionsOn?.(device) ?? []).length > 0) {
      return "session_holds_device";
    }
    const claim = await this.deps.claims.describe(device);
    if (claim.kind === "held") {
      return "held";
    }
    if (claim.kind === "unknown") {
      return "claim_unknown";
    }
    return this.deps.isBusy?.(device) === undefined ? undefined : "busy";
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

/** The deletion marker is never reverted: absence completes it, redrive retries it. */
export class JournaledManagedSlotCacheEvictor implements ManagedSlotCacheEvictor {
  constructor(
    private readonly registry: Pick<SlotRegistry, "beginFreeDeviceDeletion">,
    private readonly journal: () => Pick<ManagedSlotJournal, "owner" | "driveFreeDeviceDeletion">,
  ) {}

  async evict(
    candidate: ManagedSlotEvictionCandidate,
    options: { signal?: AbortSignal; deadlineMs?: number },
  ): Promise<ManagedSlotEvictionResult> {
    options.signal?.throwIfAborted();
    const journal = this.journal();
    const begun = await this.registry.beginFreeDeviceDeletion(candidate, journal.owner);
    if (begun.kind !== "begun") {
      return { kind: "lost" };
    }
    const result = await journal.driveFreeDeviceDeletion(begun.row, options);
    if (result.kind === "absent" || result.kind === "lost") {
      return { kind: result.kind };
    }
    return {
      kind: "failed",
      message: "message" in result ? result.message : "Deletion was not confirmed.",
    };
  }
}
