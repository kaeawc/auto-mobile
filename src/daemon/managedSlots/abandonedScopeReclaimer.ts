/**
 * Abandoned managed-slot scope reclamation (#11174 part c, epic #11172).
 *
 * Owner decisions 2026-10-09: a scope with no activity (acquisition or execution release) and no
 * live execution owner or settler for one hour is abandoned and its devices may be deleted (Q3);
 * the same incarnation returning revives it.
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
 * New deletes are accepted only for abandoned scopes; a valid scope's device is never newly
 * fenced. Accepted journaled deletes complete even after revival, and only while the slot still
 * holds the entry's exact binding.
 */

import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import type { BindingJournal } from "../sessionBroker/registry/bindingJournal";
import {
  FENCING_BINDING_STATES,
  type AbandonmentQuery,
  type BindingAssignmentRecord,
  type BindingKey,
  type BindingPlatform,
  type BindingRegistry,
} from "../sessionBroker/registry/bindingRegistry";

/** How often the daemon looks for abandoned scopes. Abandonment itself takes an hour. */
export const ABANDONED_SCOPE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export type AbandonedScopeReclaimRegistry = Pick<
  BindingRegistry,
  | "findAbandonedScopes"
  | "markScopeAbandoned"
  | "listAbandonedScopes"
  | "listAssignments"
  | "getAssignment"
  | "listOpenBindingJournal"
  | "openBindingJournal"
>;

/** The journal operations the sweep drives its deletions through. */
export type AbandonedScopeReclaimJournal = Pick<
  BindingJournal,
  "owner" | "redriveBinding" | "advance"
>;

export interface ReclaimedSlotDevice {
  scopeKey: string;
  bindingIndex: number;
  platform: BindingPlatform;
  stableDeviceId: string;
}

export interface AbandonedScopeSweepReport {
  /** Scopes this sweep marked abandoned. */
  marked: string[];
  /** Devices deleted (absence verified) and cleared from their slots. */
  deleted: ReclaimedSlotDevice[];
  /** Slots whose journaled work is blocked; the entry stays open and is redriven later. */
  blocked: Array<{ scopeKey: string; bindingIndex: number; reason: string; message: string }>;
  /** Slots left alone, with why (revived, live owner, journal already open elsewhere). */
  skipped: Array<{ scopeKey: string; bindingIndex: number; reason: string }>;
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

function keyOf(binding: BindingKey): BindingKey {
  return { scopeKey: binding.scopeKey, bindingIndex: binding.bindingIndex };
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
        logger.warn(`[Bindings] Abandoned scope sweep failed: ${errorMessage(error)}`, error);
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
        logger.info(`[Bindings] Scope ${scope.scopeKey} abandoned; reclaiming its devices`);
        report.marked.push(scope.scopeKey);
      }
    }
    for (const scope of await registry.listAbandonedScopes()) {
      for (const binding of await registry.listAssignments(scope.scopeKey)) {
        await this.reclaimSlot(registry, journal, binding, report);
      }
    }
    return report;
  }

  private async reclaimSlot(
    registry: AbandonedScopeReclaimRegistry,
    journal: AbandonedScopeReclaimJournal,
    binding: BindingAssignmentRecord,
    report: AbandonedScopeSweepReport,
  ): Promise<void> {
    const key = keyOf(binding);
    const unfinished =
      FENCING_BINDING_STATES.has(binding.state) ||
      (await registry.listOpenBindingJournal(key)).length > 0;
    if (unfinished) {
      // Earlier work on this slot (ours after a crash, or a reconcile's): redrive it, never stack.
      await this.drive(registry, journal, binding, binding.stableDeviceId, report);
      return;
    }
    if (binding.stableDeviceId === null) {
      return;
    }
    const opened = await registry.openBindingJournal(key, {
      kind: "replace",
      requireAbandonedScope: true,
      phase: "deleting",
      target: {
        oldStableId: binding.stableDeviceId,
        oldName: binding.deviceName,
        newName: null,
        newStableId: null,
        requestedSpec: binding.requestedSpec,
        resolvedSpec: binding.resolvedSpec,
        specFingerprint: binding.specFingerprint,
      },
      owner: journal.owner,
      assignment: {
        kind: "state",
        expected: { generation: binding.generation, stableDeviceId: binding.stableDeviceId },
        state: "replacing",
      },
    });
    if (opened.kind !== "opened") {
      report.skipped.push({
        ...key,
        reason:
          opened.kind === "scope_not_abandoned" && opened.scope?.state === "valid"
            ? "scope_revived"
            : opened.kind,
      });
      return;
    }
    await this.drive(registry, journal, binding, binding.stableDeviceId, report);
  }

  private async drive(
    registry: AbandonedScopeReclaimRegistry,
    journal: AbandonedScopeReclaimJournal,
    binding: BindingAssignmentRecord,
    stableDeviceId: string | null,
    report: AbandonedScopeSweepReport,
  ): Promise<void> {
    const key = keyOf(binding);
    const result = await journal.redriveBinding(key);
    if (result.kind === "blocked") {
      report.blocked.push({ ...key, reason: result.reason, message: result.message });
      return;
    }
    const after = await registry.getAssignment(key);
    if (stableDeviceId !== null && after !== null && after.stableDeviceId === null) {
      report.deleted.push({ ...key, platform: binding.platform, stableDeviceId });
    }
  }
}
