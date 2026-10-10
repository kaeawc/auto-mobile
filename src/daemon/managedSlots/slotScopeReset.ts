/**
 * Managed slot scope reset (#11174 part c, epic #11172).
 *
 * Invalidates exactly one runner incarnation's scope and hands its devices to the managed free pool,
 * for the operator command `--daemon reset-slot-scope` and for an acquisition that arrives with a
 * new incarnation of the same namespace (owner decision Q2: both).
 *
 * The reset is idempotent and ownership-safe: the scope moves to `invalidating` first, which blocks
 * new acquisitions at once, then the reset waits a bounded budget for live execution owners,
 * slots still `settling` under a live settler, `cleanup_pending` slots and open journal entries
 * (#11179: accepted cleanup is never abandoned) to settle. Only a settled scope is invalidated; its devices move to the
 * free pool, where only managed slots can adopt them. Scopes of other namespaces or incarnations are
 * never touched. An unsettled scope stays `invalidating` and is reported `pending` with the owners
 * and slots it is waiting on, so the caller can retry; a repeated reset resumes where it stopped.
 */

import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { Timer } from "../../utils/SystemTimer";
import type {
  CompleteScopeInvalidationResult,
  SlotAssignmentRecord,
  SlotJournalEntry,
  SlotPlatform,
  SlotRegistry,
  SlotScopeInvalidationReason,
  SlotScopeQuery,
  SlotScopeRecord,
} from "./slotRegistry";

/** How long a reset waits for old owners and cleanup before reporting `pending`. */
export const SLOT_SCOPE_RESET_DEFAULT_WAIT_MS = 10_000;
/** Upper bound a caller may ask for; the CLI's socket call budget is derived from it. */
export const SLOT_SCOPE_RESET_MAX_WAIT_MS = 60_000;
/** How often an unsettled scope is re-checked while waiting. */
export const SLOT_SCOPE_RESET_POLL_MS = 250;

export type SlotScopeResetRegistry = Pick<
  SlotRegistry,
  | "findScopes"
  | "beginScopeInvalidation"
  | "completeScopeInvalidation"
  | "listAssignments"
  | "listOpenSlotJournal"
  | "advanceSlotJournal"
>;

export type SlotScopeResetScopeOutcome = "invalidated" | "already_invalidated" | "pending";

export interface SlotScopeResetPendingOwner {
  slotIndex: number;
  sessionUuid: string;
  pid: number;
}

export interface SlotScopeResetPendingCleanup {
  slotIndex: number;
  platform: SlotPlatform;
  stableDeviceId: string | null;
}

export interface SlotScopeResetPendingJournal {
  slotIndex: number;
  entryId: number;
  kind: SlotJournalEntry["kind"];
  phase: SlotJournalEntry["phase"];
}

export interface SlotScopeResetScopeResult {
  scopeKey: string;
  managedHostScope: string;
  runnerNamespace: string;
  runnerIncarnation: string;
  outcome: SlotScopeResetScopeOutcome;
  /** Devices this reset moved to the managed free pool (empty when already invalidated). */
  freedDevices: Array<{ platform: SlotPlatform; stableDeviceId: string }>;
  /** What the scope is still waiting on; present only when `pending`. */
  pending?: {
    liveOwners: SlotScopeResetPendingOwner[];
    /** Slots whose released work is still settling under a live settler. */
    settling: SlotScopeResetPendingCleanup[];
    cleanupPending: SlotScopeResetPendingCleanup[];
    /** Unfinished journaled work (#11179) on the scope's slots. */
    openJournal: SlotScopeResetPendingJournal[];
  };
}

export interface SlotScopeResetResult {
  /**
   * `invalidated`: every matching scope is now invalidated (this call or earlier). `pending`: at
   * least one is still waiting for owners or cleanup; retry. `not_found`: no scope matched.
   */
  outcome: "invalidated" | "pending" | "not_found";
  retryable: boolean;
  scopes: SlotScopeResetScopeResult[];
  waitedMs: number;
}

export interface SlotScopeResetRequest extends SlotScopeQuery {
  /** Bounded settle wait, clamped to {@link SLOT_SCOPE_RESET_MAX_WAIT_MS}. */
  waitMs?: number;
  /**
   * Operator override (#11336): a slot stuck `settling` after its released work outlived the
   * settlement cap is returned to `ready` (its release journal entry committed) so the reset can
   * proceed. It overrides "settling", never "in use": a slot with an execution owner still blocks.
   */
  force?: boolean;
}

export interface SlotScopeResetOptions {
  registry: () => Promise<SlotScopeResetRegistry>;
  /**
   * Whether the registry exists. While it does not, no scope can match and the reset does not open
   * (and so create) it. Defaults to always existing.
   */
  registryExists?: () => boolean;
  timer: Pick<Timer, "now" | "sleep">;
  pollMs?: number;
}

export class SlotScopeReset {
  private readonly pollMs: number;

  constructor(private readonly options: SlotScopeResetOptions) {
    this.pollMs = options.pollMs ?? SLOT_SCOPE_RESET_POLL_MS;
  }

  /** The operator reset: every scope of `(namespace, incarnation)`, optionally one host scope. */
  async reset(request: SlotScopeResetRequest): Promise<SlotScopeResetResult> {
    const startedAtMs = this.options.timer.now();
    if (this.options.registryExists?.() === false) {
      return { outcome: "not_found", retryable: false, scopes: [], waitedMs: 0 };
    }
    const registry = await this.options.registry();
    const scopes = await registry.findScopes({
      runnerNamespace: request.runnerNamespace,
      runnerIncarnation: request.runnerIncarnation,
      managedHostScope: request.managedHostScope,
    });
    if (scopes.length === 0) {
      return { outcome: "not_found", retryable: false, scopes: [], waitedMs: 0 };
    }
    const deadlineMs = startedAtMs + clampWaitMs(request.waitMs);
    const results = await Promise.all(
      scopes.map((scope) =>
        this.invalidate(registry, scope, "operator_reset", deadlineMs, request.force === true),
      ),
    );
    const pending = results.some((result) => result.outcome === "pending");
    return {
      outcome: pending ? "pending" : "invalidated",
      retryable: pending,
      scopes: results,
      waitedMs: this.options.timer.now() - startedAtMs,
    };
  }

  /**
   * The implicit reset an acquisition triggers for a superseded incarnation (`incarnation_reset`).
   * Same settle rules; the caller reports `scope_transition_pending` when this returns `pending`.
   */
  async resetSupersededScope(
    scope: SlotScopeRecord,
    waitMs?: number,
  ): Promise<SlotScopeResetScopeResult> {
    const registry = await this.options.registry();
    const deadlineMs = this.options.timer.now() + clampWaitMs(waitMs);
    return this.invalidate(registry, scope, "incarnation_reset", deadlineMs);
  }

  private async invalidate(
    registry: SlotScopeResetRegistry,
    scope: SlotScopeRecord,
    reason: SlotScopeInvalidationReason,
    deadlineMs: number,
    force = false,
  ): Promise<SlotScopeResetScopeResult> {
    const base = {
      scopeKey: scope.scopeKey,
      managedHostScope: scope.managedHostScope,
      runnerNamespace: scope.runnerNamespace,
      runnerIncarnation: scope.runnerIncarnation,
    };
    // Idempotent: blocks acquisitions now, and turns an abandoned (revivable) scope permanent.
    await registry.beginScopeInvalidation(scope.scopeKey, reason);
    if (force) {
      await this.abandonSettlement(registry, scope);
    }
    for (;;) {
      const completed = await registry.completeScopeInvalidation(scope.scopeKey);
      if (completed.kind === "invalidated") {
        return {
          ...base,
          outcome: "invalidated",
          freedDevices: completed.freedDevices.map((device) => ({
            platform: device.platform,
            stableDeviceId: device.stableDeviceId,
          })),
        };
      }
      if (completed.kind === "already_invalidated" || completed.kind === "not_found") {
        return { ...base, outcome: "already_invalidated", freedDevices: [] };
      }
      if (completed.kind === "not_invalidating") {
        // Not marked (yet): mark it again and re-check on the next pass, within the same budget.
        await registry.beginScopeInvalidation(scope.scopeKey, reason);
      }
      const waitingOn =
        completed.kind === "pending"
          ? pendingEvidence(completed)
          : { liveOwners: [], settling: [], cleanupPending: [], openJournal: [] };
      const remainingMs = deadlineMs - this.options.timer.now();
      if (remainingMs <= 0) {
        return { ...base, outcome: "pending", freedDevices: [], pending: waitingOn };
      }
      await this.options.timer.sleep(Math.min(this.pollMs, remainingMs));
    }
  }

  /**
   * Return each unowned `settling` slot of the scope to `ready`, committing its release journal
   * entry in the same transaction (the existing journal API, never by hand). A slot with an
   * execution owner, with no open release entry, or with other open journal work is left for the
   * normal wait.
   */
  private async abandonSettlement(
    registry: SlotScopeResetRegistry,
    scope: SlotScopeRecord,
  ): Promise<void> {
    const slots = (await registry.listAssignments(scope.scopeKey)).filter(
      (slot) => slot.state === "settling" && slot.execOwner === null,
    );
    for (const slot of slots) {
      const key = { scopeKey: slot.scopeKey, slotIndex: slot.slotIndex };
      try {
        const open = await registry.listOpenSlotJournal(key);
        if (open.some((entry) => entry.kind !== "release")) {
          continue;
        }
        const release = open.find((entry) => entry.kind === "release");
        if (!release) {
          continue;
        }
        const result = await registry.advanceSlotJournal(release.id, {
          owner: release.owner,
          expectedPhase: release.phase,
          phase: "committed",
          assignment: { kind: "state", expected: release.binding, state: "ready" },
        });
        logger.warn(
          `[SlotScopeReset] --force abandoned the settlement of slot ${key.scopeKey}/${key.slotIndex} ` +
            `(${result.kind}); its released work may still be running (#11336)`,
        );
      } catch (error) {
        logger.warn(
          `[SlotScopeReset] --force could not abandon slot ${key.scopeKey}/${key.slotIndex}: ${errorMessage(error)}`,
          error,
        );
      }
    }
  }
}

function pendingEvidence(
  completed: Extract<CompleteScopeInvalidationResult, { kind: "pending" }>,
): NonNullable<SlotScopeResetScopeResult["pending"]> {
  const slotRef = (slot: SlotAssignmentRecord): SlotScopeResetPendingCleanup => ({
    slotIndex: slot.slotIndex,
    platform: slot.platform,
    stableDeviceId: slot.stableDeviceId,
  });
  return {
    liveOwners: completed.liveOwners.flatMap((slot) =>
      slot.execOwner
        ? [
            {
              slotIndex: slot.slotIndex,
              sessionUuid: slot.execOwner.sessionUuid,
              pid: slot.execOwner.pid,
            },
          ]
        : [],
    ),
    settling: completed.settling.map(slotRef),
    cleanupPending: completed.cleanupPending.map(slotRef),
    openJournal: completed.openJournal.map((entry) => ({
      slotIndex: entry.slotIndex,
      entryId: entry.id,
      kind: entry.kind,
      phase: entry.phase,
    })),
  };
}

function clampWaitMs(waitMs: number | undefined): number {
  if (waitMs === undefined || !Number.isFinite(waitMs) || waitMs < 0) {
    return SLOT_SCOPE_RESET_DEFAULT_WAIT_MS;
  }
  return Math.min(waitMs, SLOT_SCOPE_RESET_MAX_WAIT_MS);
}
