/**
 * Abandoned managed-slot scope reclamation (#11174 part c, epic #11172).
 *
 * Owner decision 2026-10-12 (#11545): a returning incarnation revives its scope and reuses
 * unjournaled devices. Already journaled deletes, even blocked ones, always complete first;
 * the reconciler then creates a new device with a later generation.
 *
 * A periodic daemon sweep, on the injected timer:
 *
 * 1. Marks every valid scope idle past the threshold as abandoned (`invalidating`, reason
 *    `abandoned`). The registry re-checks activity, live owners and settlers atomically.
 * 2. Atomically checks that the scope is still abandoned and opens a delete-only journal entry
 *    (#11179), fencing the slot `replacing` (generation + 1, refused for a live execution owner).
 *    A revive committed before the entry keeps the device without a fence. After the entry commits,
 *    the journal deletes, verifies absence and records the empty slot, even if the scope revives.
 * 3. Slots of abandoned scopes that already carry unfinished journaled work, or a fencing state
 *    (`replacing`, `settling`, `cleanup_pending`), are handed to the journal's redrive, which adopts
 *    entries of dead owners, honours backoff and settlers, and never repeats completed destructive
 *    work. A crash mid-delete therefore leaves an open entry that the next sweep (or the slot's next
 *    acquisition) redrives to convergence.
 *
 * New deletes are accepted only for abandoned scopes. Accepted journaled deletes complete even
 * after revival, and only while the slot still holds the entry's exact binding.
 */

import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import type { ManagedSlotJournal } from "./slotJournal";
import {
  FENCING_SLOT_STATES,
  isAbandonedScope,
  type AbandonmentQuery,
  type SlotAssignmentRecord,
  type SlotKey,
  type SlotPlatform,
  type SlotRegistry,
} from "./slotRegistry";

/** How often the daemon looks for abandoned scopes. Abandonment itself takes an hour. */
export const ABANDONED_SCOPE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export type AbandonedScopeReclaimRegistry = Pick<
  SlotRegistry,
  | "findAbandonedScopes"
  | "markScopeAbandoned"
  | "listAbandonedScopes"
  | "listAssignments"
  | "getAssignment"
  | "listOpenSlotJournal"
  | "openSlotJournal"
>;

/** The journal operations the sweep drives its deletions through. */
export type AbandonedScopeReclaimJournal = Pick<
  ManagedSlotJournal,
  "owner" | "redriveSlot" | "advance"
>;

export interface ReclaimedSlotDevice {
  scopeKey: string;
  slotIndex: number;
  platform: SlotPlatform;
  stableDeviceId: string;
}

export interface AbandonedScopeSweepReport {
  /** Scopes this sweep marked abandoned. */
  marked: string[];
  /** Devices deleted (absence verified) and cleared from their slots. */
  deleted: ReclaimedSlotDevice[];
  /** Slots whose journaled work is blocked; the entry stays open and is redriven later. */
  blocked: Array<{ scopeKey: string; slotIndex: number; reason: string; message: string }>;
  /** Slots left alone, with why (revived, live owner, journal already open elsewhere). */
  skipped: Array<{ scopeKey: string; slotIndex: number; reason: string }>;
}

export interface AbandonedScopeReclaimerOptions {
  registry: () => Promise<AbandonedScopeReclaimRegistry>;
  /** The journal over the same registry. */
  journal: (registry: AbandonedScopeReclaimRegistry) => AbandonedScopeReclaimJournal;
  timer: Pick<Timer, "setInterval" | "clearInterval">;
  intervalMs?: number;
  /**
   * Whether the registry exists. While it does not, nothing can be abandoned and the sweep does not
   * open (and so create) it. Defaults to always existing.
   */
  registryExists?: () => boolean;
  /** Abandonment threshold; defaults to the registry's one hour. */
  abandonment?: AbandonmentQuery;
}

function emptyReport(): AbandonedScopeSweepReport {
  return { marked: [], deleted: [], blocked: [], skipped: [] };
}

function keyOf(slot: SlotKey): SlotKey {
  return { scopeKey: slot.scopeKey, slotIndex: slot.slotIndex };
}

export class AbandonedScopeReclaimer {
  private interval: NodeJS.Timeout | undefined;
  private running: Promise<AbandonedScopeSweepReport> | undefined;

  constructor(private readonly options: AbandonedScopeReclaimerOptions) {}

  start(): void {
    if (this.interval) {
      return;
    }
    this.interval = this.options.timer.setInterval(() => {
      this.sweep().catch((error: unknown) => {
        logger.warn(`[ManagedSlots] Abandoned scope sweep failed: ${errorMessage(error)}`, error);
      });
    }, this.options.intervalMs ?? ABANDONED_SCOPE_SWEEP_INTERVAL_MS);
    // A periodic sweep must never keep the daemon process alive on its own.
    const handle = this.interval as { unref?: () => void };
    if (typeof handle.unref === "function") {
      handle.unref();
    }
  }

  stop(): void {
    if (this.interval) {
      this.options.timer.clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  /** One sweep; concurrent callers share the in-flight one. */
  sweep(): Promise<AbandonedScopeSweepReport> {
    this.running ??= this.runSweep().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runSweep(): Promise<AbandonedScopeSweepReport> {
    const report = emptyReport();
    if (this.options.registryExists?.() === false) {
      return report;
    }
    const registry = await this.options.registry();
    const journal = this.options.journal(registry);
    for (const scope of await registry.findAbandonedScopes(this.options.abandonment)) {
      const marked = await registry.markScopeAbandoned(scope.scopeKey, this.options.abandonment);
      if (marked.kind === "marked") {
        logger.info(`[ManagedSlots] Scope ${scope.scopeKey} abandoned; reclaiming its devices`);
        report.marked.push(scope.scopeKey);
      }
    }
    for (const scope of await registry.listAbandonedScopes()) {
      if (!isAbandonedScope(scope)) {
        continue;
      }
      for (const slot of await registry.listAssignments(scope.scopeKey)) {
        await this.reclaimSlot(registry, journal, slot, report);
      }
    }
    return report;
  }

  private async reclaimSlot(
    registry: AbandonedScopeReclaimRegistry,
    journal: AbandonedScopeReclaimJournal,
    slot: SlotAssignmentRecord,
    report: AbandonedScopeSweepReport,
  ): Promise<void> {
    const key = keyOf(slot);
    const unfinished =
      FENCING_SLOT_STATES.has(slot.state) || (await registry.listOpenSlotJournal(key)).length > 0;
    if (unfinished) {
      // Earlier work on this slot (ours after a crash, or a reconcile's): redrive it, never stack.
      await this.drive(registry, journal, slot, slot.stableDeviceId, report);
      return;
    }
    if (slot.stableDeviceId === null) {
      return;
    }
    const opened = await registry.openSlotJournal(key, {
      kind: "replace",
      requireAbandonedScope: true,
      phase: "deleting",
      target: {
        oldStableId: slot.stableDeviceId,
        oldName: slot.deviceName,
        newName: null,
        newStableId: null,
        requestedSpec: slot.requestedSpec,
        resolvedSpec: slot.resolvedSpec,
        specFingerprint: slot.specFingerprint,
      },
      owner: journal.owner,
      assignment: {
        kind: "state",
        expected: { generation: slot.generation, stableDeviceId: slot.stableDeviceId },
        state: "replacing",
      },
    });
    if (opened.kind !== "opened") {
      report.skipped.push({
        ...key,
        reason: opened.kind === "scope_not_abandoned" ? "scope_revived" : opened.kind,
      });
      return;
    }
    await this.drive(registry, journal, slot, slot.stableDeviceId, report);
  }

  private async drive(
    registry: AbandonedScopeReclaimRegistry,
    journal: AbandonedScopeReclaimJournal,
    slot: SlotAssignmentRecord,
    stableDeviceId: string | null,
    report: AbandonedScopeSweepReport,
  ): Promise<void> {
    const key = keyOf(slot);
    const result = await journal.redriveSlot(key);
    if (result.kind === "blocked") {
      report.blocked.push({ ...key, reason: result.reason, message: result.message });
      return;
    }
    const after = await registry.getAssignment(key);
    if (stableDeviceId !== null && after !== null && after.stableDeviceId === null) {
      report.deleted.push({ ...key, platform: slot.platform, stableDeviceId });
    }
  }
}
