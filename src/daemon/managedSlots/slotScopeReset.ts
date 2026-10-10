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
import { MANAGED_EXECUTION_SETTLEMENT_CAP_MS } from "./managedExecutionRelease";
import { defaultSlotExecOwnerLiveness } from "./slotOwnerLiveness";
import type {
  CompleteScopeInvalidationResult,
  SlotAssignmentRecord,
  SlotExecOwnerLiveness,
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

/** Why `--force` left a `settling` slot alone (#11539). */
export type SlotScopeResetForceRefusalReason =
  | "within_settlement_cap"
  | "no_release_entry"
  | "other_open_journal"
  | "abandon_failed";

export interface SlotScopeResetForceRefusal {
  slotIndex: number;
  reason: SlotScopeResetForceRefusalReason;
  /** Time until the slot outlives the settlement cap; set for `within_settlement_cap`. */
  remainingMs?: number;
  /** What happened and what the operator should do. */
  message: string;
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
  /** Slots `--force` declined to abandon, and why; present only when `pending` after a forced reset. */
  forceRefusals?: SlotScopeResetForceRefusal[];
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
   * proceed. It overrides "stuck settling", never "settling normally" and never "in use": a slot
   * still inside the cap, or with an execution owner, still blocks (#11539).
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
  /** Age of a release after which its settlement counts as stuck. Default: the watcher's cap. */
  settlementCapMs?: number;
  /**
   * Judges a `settling` slot's owner record for `--force` (#11545): pass the registry's own
   * predicate, so the reset and the registry agree. Default: PID plus process start identity.
   */
  isExecOwnerLive?: SlotExecOwnerLiveness;
}

export class SlotScopeReset {
  private readonly pollMs: number;
  private readonly settlementCapMs: number;
  private readonly isExecOwnerLive: SlotExecOwnerLiveness;

  constructor(private readonly options: SlotScopeResetOptions) {
    this.isExecOwnerLive = options.isExecOwnerLive ?? defaultSlotExecOwnerLiveness;
    this.pollMs = options.pollMs ?? SLOT_SCOPE_RESET_POLL_MS;
    this.settlementCapMs = options.settlementCapMs ?? MANAGED_EXECUTION_SETTLEMENT_CAP_MS;
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
    const forceRefusals = force ? await this.abandonSettlement(registry, scope) : [];
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
        return {
          ...base,
          outcome: "pending",
          freedDevices: [],
          pending: waitingOn,
          ...(forceRefusals.length > 0 ? { forceRefusals } : {}),
        };
      }
      await this.options.timer.sleep(Math.min(this.pollMs, remainingMs));
    }
  }

  /**
   * Return each `settling` slot of the scope with no live owner that is provably stuck to `ready`, committing
   * its release journal entry in the same transaction (the existing journal API, never by hand).
   * Stuck means the release outlived the settlement cap, the watcher's own "past cap" state
   * (#11539). A slot with a live execution owner is left for the normal wait; every other slot left
   * alone is returned as a typed refusal saying why and what to do.
   */
  private async abandonSettlement(
    registry: SlotScopeResetRegistry,
    scope: SlotScopeRecord,
  ): Promise<SlotScopeResetForceRefusal[]> {
    const slots = (await registry.listAssignments(scope.scopeKey)).filter(
      // An owner record dead by liveness (its clear failed) is not an execution in use (#11545).
      (slot) => slot.state === "settling" && !this.hasLiveOwner(slot),
    );
    const refusals: SlotScopeResetForceRefusal[] = [];
    for (const slot of slots) {
      const key = { scopeKey: slot.scopeKey, slotIndex: slot.slotIndex };
      const label = `${key.scopeKey}/${key.slotIndex}`;
      try {
        const open = await registry.listOpenSlotJournal(key);
        const release = open.find((entry) => entry.kind === "release");
        if (open.some((entry) => entry.kind !== "release")) {
          refusals.push({
            slotIndex: key.slotIndex,
            reason: "other_open_journal",
            message:
              `Slot ${label} has unfinished non-release journal work; --force does not abandon it. ` +
              "Wait for the redrive to finish, then retry.",
          });
          continue;
        }
        if (!release) {
          refusals.push({
            slotIndex: key.slotIndex,
            reason: "no_release_entry",
            message:
              `Slot ${label} is settling but has no open release journal entry, so --force cannot ` +
              "tell whether it is stuck. Wait for its settler to return it to ready, or inspect it.",
          });
          continue;
        }
        const remainingMs = release.createdAtMs + this.settlementCapMs - this.options.timer.now();
        if (remainingMs > 0) {
          refusals.push({
            slotIndex: key.slotIndex,
            reason: "within_settlement_cap",
            remainingMs,
            message:
              `Slot ${label} is still settling normally and its released work may be running. ` +
              `Wait, or retry --force in ${remainingMs}ms once it outlives the settlement cap.`,
          });
          continue;
        }
        const result = await registry.advanceSlotJournal(release.id, {
          owner: release.owner,
          expectedPhase: release.phase,
          phase: "committed",
          assignment: { kind: "state", expected: release.binding, state: "ready" },
        });
        if (result.kind === "advanced") {
          logger.warn(
            `[SlotScopeReset] --force abandoned the settlement of slot ${label}, stuck past the ` +
              `${this.settlementCapMs}ms cap; its released work may still be running (#11336)`,
          );
        } else {
          logger.warn(`[SlotScopeReset] --force could not abandon slot ${label}: ${result.kind}`);
          refusals.push({
            slotIndex: key.slotIndex,
            reason: "abandon_failed",
            message: `Slot ${label} changed while --force abandoned it (${result.kind}); retry.`,
          });
        }
      } catch (error) {
        logger.warn(
          `[SlotScopeReset] --force could not abandon slot ${label}: ${errorMessage(error)}`,
          error,
        );
        refusals.push({
          slotIndex: key.slotIndex,
          reason: "abandon_failed",
          message: `Slot ${label} could not be abandoned: ${errorMessage(error)}. Retry.`,
        });
      }
    }
    return refusals;
  }

  private hasLiveOwner(slot: SlotAssignmentRecord): boolean {
    return slot.execOwner !== null && this.isExecOwnerLive(slot.execOwner);
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
