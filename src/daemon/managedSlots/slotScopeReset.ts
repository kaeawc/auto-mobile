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
  SlotExecOwner,
  SlotExecOwnerLiveness,
  SlotJournalEntry,
  SlotPlatform,
  SlotProcessIdentity,
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

/**
 * Why `--force` left a slot alone (#11539, #11545). `live_owner`: an execution this daemon holds is
 * using it. `owner_liveness_unknown`: its owner record belongs to another running process, whose
 * session liveness this daemon cannot know, so it is neither cut nor guessed dead. The rest
 * describe a `settling` slot without a live owner.
 */
export type SlotScopeResetForceRefusalReason =
  | "live_owner"
  | "owner_liveness_unknown"
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
  /**
   * Slots `--force` left alone (in use, or a settlement it declined to abandon), and why; present
   * only when `pending` after a forced reset.
   */
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
   * still inside the cap whose settling daemon is not provably gone, or with a live execution
   * owner, still blocks (#11539, #11545).
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
  /**
   * This daemon. An owner record another process wrote is live while that process runs, whatever
   * became of its session there, so `--force` reports it as unknowable from here rather than as an
   * execution in use (#11545). Default: this process.
   */
  thisProcess?: Pick<SlotProcessIdentity, "pid">;
}

export class SlotScopeReset {
  private readonly pollMs: number;
  private readonly settlementCapMs: number;
  private readonly isExecOwnerLive: SlotExecOwnerLiveness;
  private readonly thisPid: number;

  constructor(private readonly options: SlotScopeResetOptions) {
    this.thisPid = (options.thisProcess ?? { pid: process.pid }).pid;
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
   * (#11539), or its settling daemon is provably gone (#11545). Every slot left alone is returned as a typed refusal saying why and what to do: a
   * slot with a live execution owner (in any state) is never touched and says so (#11545).
   */
  private async abandonSettlement(
    registry: SlotScopeResetRegistry,
    scope: SlotScopeRecord,
  ): Promise<SlotScopeResetForceRefusal[]> {
    const refusals: SlotScopeResetForceRefusal[] = [];
    for (const slot of await registry.listAssignments(scope.scopeKey)) {
      const refusal = await this.forceSlot(registry, slot);
      if (refusal) {
        refusals.push(refusal);
      }
    }
    return refusals;
  }

  /** Apply `--force` to one slot; resolves to why it was left alone, if it was. */
  private async forceSlot(
    registry: SlotScopeResetRegistry,
    slot: SlotAssignmentRecord,
  ): Promise<SlotScopeResetForceRefusal | undefined> {
    // An owner record dead by liveness (its clear failed) is not an execution in use (#11545).
    if (slot.execOwner !== null && this.isExecOwnerLive(slot.execOwner)) {
      return this.liveOwnerRefusal(slot, slot.execOwner);
    }
    if (slot.state !== "settling") {
      return undefined;
    }
    const label = `${slot.scopeKey}/${slot.slotIndex}`;
    try {
      return await this.abandonSettlingSlot(registry, slot);
    } catch (error) {
      logger.warn(
        `[SlotScopeReset] --force could not abandon slot ${label}: ${errorMessage(error)}`,
        error,
      );
      return {
        slotIndex: slot.slotIndex,
        reason: "abandon_failed",
        message: `Slot ${label} could not be abandoned: ${errorMessage(error)}. Retry.`,
      };
    }
  }

  /**
   * The refusal for a slot whose owner record the liveness predicate counts as live. A record this
   * daemon wrote is judged by its session, and one whose process is gone can only be live because
   * this daemon holds its session: both are executions in use here. A record of another running
   * process is live by that process alone; whether its session ended there cannot be known from
   * this daemon, so the refusal says so instead of guessing either way.
   */
  private liveOwnerRefusal(
    slot: SlotAssignmentRecord,
    owner: SlotExecOwner,
  ): SlotScopeResetForceRefusal {
    const label = `${slot.scopeKey}/${slot.slotIndex}`;
    const ownerProcess: SlotProcessIdentity = {
      daemonId: owner.daemonId,
      pid: owner.pid,
      processGenerationToken: owner.processGenerationToken,
    };
    if (owner.pid === this.thisPid || !this.isExecOwnerLive(ownerProcess)) {
      return {
        slotIndex: slot.slotIndex,
        reason: "live_owner",
        message:
          `Slot ${label} is in use by execution ${owner.sessionUuid}, which this daemon holds; ` +
          "--force never overrides an execution in use. Release that execution, then retry.",
      };
    }
    return {
      slotIndex: slot.slotIndex,
      reason: "owner_liveness_unknown",
      message:
        `Slot ${label} is owned by execution ${owner.sessionUuid} of another running daemon ` +
        `(${owner.daemonId}, pid ${owner.pid}). This daemon cannot tell whether that execution ` +
        "has ended there, so --force leaves the slot alone. Run the reset through that daemon, " +
        "or restart it (its record then reads dead), then retry.",
    };
  }

  /** Abandon one `settling` slot without a live owner, or say why not. May throw (registry). */
  private async abandonSettlingSlot(
    registry: SlotScopeResetRegistry,
    slot: SlotAssignmentRecord,
  ): Promise<SlotScopeResetForceRefusal | undefined> {
    const key = { scopeKey: slot.scopeKey, slotIndex: slot.slotIndex };
    const label = `${key.scopeKey}/${key.slotIndex}`;
    const open = await registry.listOpenSlotJournal(key);
    const release = open.find((entry) => entry.kind === "release");
    if (open.some((entry) => entry.kind !== "release")) {
      return {
        slotIndex: key.slotIndex,
        reason: "other_open_journal",
        message:
          `Slot ${label} has unfinished non-release journal work; --force does not abandon it. ` +
          "Wait for the redrive to finish, then retry.",
      };
    }
    if (!release) {
      return {
        slotIndex: key.slotIndex,
        reason: "no_release_entry",
        message:
          `Slot ${label} is settling under ${describeSettler(slot.settler)} but has no open ` +
          "release journal entry, so --force cannot tell whether it is stuck and does not " +
          "abandon it. Wait for that daemon to return it to ready; if it does not, restart that " +
          "daemon (startup recovery returns a slot whose settler is gone to ready), then retry.",
      };
    }
    const remainingMs = release.createdAtMs + this.settlementCapMs - this.options.timer.now();
    const settlerGone = this.isSettlerProvablyDead(slot, release);
    if (remainingMs > 0 && !settlerGone) {
      return {
        slotIndex: key.slotIndex,
        reason: "within_settlement_cap",
        remainingMs,
        message:
          `Slot ${label} is still settling under ${describeSettler(slot.settler)}, which is not ` +
          "known to be gone, so its released work may be running. " +
          `Wait, or retry --force in ${remainingMs}ms once it outlives the settlement cap.`,
      };
    }
    const result = await registry.advanceSlotJournal(release.id, {
      owner: release.owner,
      expectedPhase: release.phase,
      phase: "committed",
      assignment: { kind: "state", expected: release.binding, state: "ready" },
    });
    if (result.kind === "advanced") {
      logger.warn(
        remainingMs > 0
          ? `[SlotScopeReset] --force abandoned the settlement of slot ${label}: its settling ` +
              `daemon is gone (${describeSettler(slot.settler)}), and its released work with it (#11545)`
          : `[SlotScopeReset] --force abandoned the settlement of slot ${label}, stuck past the ` +
              `${this.settlementCapMs}ms cap; its released work may still be running (#11336)`,
      );
      return undefined;
    }
    logger.warn(`[SlotScopeReset] --force could not abandon slot ${label}: ${result.kind}`);
    return {
      slotIndex: key.slotIndex,
      reason: "abandon_failed",
      message: `Slot ${label} changed while --force abandoned it (${result.kind}); retry.`,
    };
  }

  /**
   * Whether the daemon settling this slot is provably gone, by the same predicate the registry's
   * own recovery uses (`recoverSettledSlots`): the released work ran in that process and died with
   * it, so nothing is "settling normally" and the cap need not be waited out (#11545). Both the
   * slot's recorded settler and the release entry's current owner (a redriving daemon may have
   * taken the entry over) must be dead. A slot with no recorded settler, or a settler whose
   * liveness cannot be decided (the predicate keeps a possibly-live process), is not provably dead.
   */
  private isSettlerProvablyDead(slot: SlotAssignmentRecord, release: SlotJournalEntry): boolean {
    return (
      slot.settler !== null &&
      !this.isExecOwnerLive(slot.settler) &&
      !this.isExecOwnerLive(release.owner)
    );
  }
}

function describeSettler(settler: SlotProcessIdentity | null): string {
  return settler === null
    ? "an unrecorded settler"
    : `settling daemon ${settler.daemonId} (pid ${settler.pid})`;
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
