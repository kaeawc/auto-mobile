/**
 * Abandoned managed-slot scope reclamation (#11174 part c, epic #11172).
 *
 * Owner decisions 2026-10-09: a scope with no activity (acquisition or execution release) and no
 * live execution owner or settler for one hour is abandoned and its devices may be deleted (Q3); if
 * the same incarnation returns, the scope is revived, surviving devices are reused and deleted ones
 * recreated by the reconciler.
 *
 * A periodic daemon sweep, on the injected timer:
 *
 * 1. Marks every valid scope idle past the threshold as abandoned (`invalidating`, reason
 *    `abandoned`). The registry re-checks activity, live owners and settlers atomically.
 * 2. For every slot of a scope still abandoned that holds a device and no fencing state, opens a
 *    journal entry (#11179) for a delete-only replacement: `replace` in phase `deleting` with no new
 *    device, anchored by fencing the slot `replacing` (generation + 1, refused while a live execution
 *    owns it). If the scope was revived in the meantime, the entry is rolled back and the slot
 *    restored. Otherwise the journal deletes and verifies absence of the recorded device and records
 *    the empty slot in the same transaction; a revived scope's next acquisition recreates it.
 * 3. Slots of abandoned scopes that already carry unfinished journaled work, or a fencing state
 *    (`replacing`, `settling`, `cleanup_pending`), are handed to the journal's redrive, which adopts
 *    entries of dead owners, honours backoff and settlers, and never repeats completed destructive
 *    work. A crash mid-delete therefore leaves an open entry that the next sweep (or the slot's next
 *    acquisition) redrives to convergence.
 *
 * Devices of valid scopes are never touched: the sweep reads only abandoned scopes, and every delete
 * runs through the journal, which deletes only while the slot still holds the entry's exact binding.
 */

import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import type { ManagedSlotJournal } from "./slotJournal";
import {
  FENCING_SLOT_STATES,
  type AbandonmentQuery,
  type SlotAssignmentRecord,
  type SlotKey,
  type SlotPlatform,
  type SlotRegistry,
  type SlotScopeRecord,
} from "./slotRegistry";

/** How often the daemon looks for abandoned scopes. Abandonment itself takes an hour. */
export const ABANDONED_SCOPE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export type AbandonedScopeReclaimRegistry = Pick<
  SlotRegistry,
  | "findAbandonedScopes"
  | "markScopeAbandoned"
  | "listAbandonedScopes"
  | "listAssignments"
  | "getScope"
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

function isAbandoned(scope: SlotScopeRecord | null): boolean {
  return scope?.state === "invalidating" && scope.invalidationReason === "abandoned";
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
      report.skipped.push({ ...key, reason: opened.kind });
      return;
    }
    // The fence is in place; a revive that landed before it keeps its device.
    if (!isAbandoned(await registry.getScope(slot.scopeKey))) {
      await journal.advance(opened.entry, {
        expectedPhase: "deleting",
        phase: "rolled_back",
        assignment: { kind: "state", expected: opened.entry.binding, state: slot.state },
      });
      report.skipped.push({ ...key, reason: "scope_revived" });
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
