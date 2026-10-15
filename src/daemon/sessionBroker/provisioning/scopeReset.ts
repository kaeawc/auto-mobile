/**
 * Binding scope reset (#11174 part c, epic #11172).
 *
 * Invalidates exactly one runner incarnation's scope and hands its devices to the managed free pool,
 * for the operator command the operator scope-reset operation and for an acquisition that arrives with a
 * new incarnation of the same namespace (owner decision Q2: both).
 *
 * The reset is idempotent and ownership-safe: the scope moves to `invalidating` first, which blocks
 * new acquisitions at once, then the reset waits a bounded budget for live execution owners,
 * bindings still `settling` under a live settler, `cleanup_pending` bindings and open journal entries
 * (#11179: accepted cleanup is never abandoned) to settle. Only a settled scope is invalidated; its devices move to the
 * free pool, where only bindings can adopt them. Scopes of other namespaces or incarnations are
 * never touched. An unsettled scope stays `invalidating` and is reported `pending` with the owners
 * and bindings it is waiting on, so the caller can retry; a repeated reset resumes where it stopped.
 */

import { classifySqliteError } from "../../../db/databaseFailureClassification";
import { BindingDiscoveryIncompleteError } from "./refusal";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { Timer } from "../../../utils/SystemTimer";
import { MANAGED_EXECUTION_SETTLEMENT_CAP_MS } from "./executionRelease";
import { defaultBindingExecOwnerLiveness } from "../registry/ownerLiveness";
import type {
  CompleteScopeInvalidationResult,
  BindingAssignmentRecord,
  BindingExecOwner,
  BindingExecOwnerLiveness,
  BindingJournalEntry,
  BindingPlatform,
  BindingProcessIdentity,
  BindingRegistry,
  BindingScopeInvalidationReason,
  BindingScopeQuery,
  BindingScopeRecord,
} from "../registry/bindingRegistry";

/** How long a reset waits for old owners and cleanup before reporting `pending`. */
export const BINDING_SCOPE_RESET_DEFAULT_WAIT_MS = 10_000;
/** Upper bound a caller may ask for; the CLI's socket call budget is derived from it. */
export const BINDING_SCOPE_RESET_MAX_WAIT_MS = 60_000;
/** How often an unsettled scope is re-checked while waiting. */
export const BINDING_SCOPE_RESET_POLL_MS = 250;

export type BindingScopeResetRegistry = Pick<
  BindingRegistry,
  | "findScopes"
  | "beginScopeInvalidation"
  | "completeScopeInvalidation"
  | "listAssignments"
  | "listOpenBindingJournal"
  | "advanceBindingJournal"
>;

export type BindingScopeResetScopeOutcome = "invalidated" | "already_invalidated" | "pending";

export interface BindingScopeResetPendingOwner {
  bindingIndex: number;
  sessionUuid: string;
  pid: number;
}

export interface BindingScopeResetPendingCleanup {
  bindingIndex: number;
  platform: BindingPlatform;
  stableDeviceId: string | null;
}

export interface BindingScopeResetPendingJournal {
  bindingIndex: number;
  entryId: number;
  kind: BindingJournalEntry["kind"];
  phase: BindingJournalEntry["phase"];
}

/**
 * Why `--force` left a binding alone (#11539, #11545). `live_owner`: an execution this daemon holds is
 * using it. `owner_liveness_unknown`: its owner record belongs to another running process, whose
 * session liveness this daemon cannot know, so it is neither cut nor guessed dead. The rest
 * describe a `settling` binding without a live owner.
 */
export type BindingScopeResetForceRefusalReason =
  | "live_owner"
  | "owner_liveness_unknown"
  | "within_settlement_cap"
  | "no_release_entry"
  | "other_open_journal"
  | "abandon_failed";

export interface BindingScopeResetForceRefusal {
  bindingIndex: number;
  reason: BindingScopeResetForceRefusalReason;
  /** Time until the binding outlives the settlement cap; set for `within_settlement_cap`. */
  remainingMs?: number;
  /** What happened and what the operator should do. */
  message: string;
}

export interface BindingScopeResetScopeResult {
  scopeKey: string;
  managedHostScope: string;
  runnerNamespace: string;
  runnerIncarnation: string;
  outcome: BindingScopeResetScopeOutcome;
  /** Devices this reset moved to the managed free pool (empty when already invalidated). */
  freedDevices: Array<{ platform: BindingPlatform; stableDeviceId: string }>;
  /** What the scope is still waiting on; present only when `pending`. */
  pending?: {
    liveOwners: BindingScopeResetPendingOwner[];
    /** Bindings whose released work is still settling under a live settler. */
    settling: BindingScopeResetPendingCleanup[];
    cleanupPending: BindingScopeResetPendingCleanup[];
    /** Unfinished journaled work (#11179) on the scope's bindings. */
    openJournal: BindingScopeResetPendingJournal[];
  };
  /**
   * Bindings `--force` left alone (in use, or a settlement it declined to abandon), and why; present
   * only when `pending` after a forced reset.
   */
  forceRefusals?: BindingScopeResetForceRefusal[];
}

export interface BindingScopeResetResult {
  /**
   * `invalidated`: every matching scope is now invalidated (this call or earlier). `pending`: at
   * least one is still waiting for owners or cleanup; retry. `not_found`: no scope matched.
   */
  outcome: "invalidated" | "pending" | "not_found";
  retryable: boolean;
  scopes: BindingScopeResetScopeResult[];
  waitedMs: number;
}

export interface BindingScopeResetRequest extends BindingScopeQuery {
  /** Bounded settle wait, clamped to {@link BINDING_SCOPE_RESET_MAX_WAIT_MS}. */
  waitMs?: number;
  /**
   * Operator override (#11336): a binding stuck `settling` after its released work outlived the
   * settlement cap is returned to `ready` (its release journal entry committed) so the reset can
   * proceed. It overrides "stuck settling", never "settling normally" and never "in use": a binding
   * still inside the cap whose settling daemon is not provably gone, or with a live execution
   * owner, still blocks (#11539, #11545).
   */
  force?: boolean;
}

export interface BindingScopeResetOptions {
  registry: () => Promise<BindingScopeResetRegistry>;
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
   * Judges a `settling` binding's owner record for `--force` (#11545): pass the registry's own
   * predicate, so the reset and the registry agree. Default: PID plus process start identity.
   */
  isExecOwnerLive?: BindingExecOwnerLiveness;
  /**
   * This daemon. An owner record another process wrote is live while that process runs, whatever
   * became of its session there, so `--force` reports it as unknowable from here rather than as an
   * execution in use (#11545). Default: this process.
   */
  thisProcess?: Pick<BindingProcessIdentity, "pid">;
}

export class BindingScopeReset {
  private readonly pollMs: number;
  private readonly settlementCapMs: number;
  private readonly isExecOwnerLive: BindingExecOwnerLiveness;
  private readonly thisPid: number;

  constructor(private readonly options: BindingScopeResetOptions) {
    this.thisPid = (options.thisProcess ?? { pid: process.pid }).pid;
    this.isExecOwnerLive = options.isExecOwnerLive ?? defaultBindingExecOwnerLiveness;
    this.pollMs = options.pollMs ?? BINDING_SCOPE_RESET_POLL_MS;
    this.settlementCapMs = options.settlementCapMs ?? MANAGED_EXECUTION_SETTLEMENT_CAP_MS;
  }

  /** The operator reset: every scope of `(namespace, incarnation)`, optionally one host scope. */
  async reset(request: BindingScopeResetRequest): Promise<BindingScopeResetResult> {
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
    scope: BindingScopeRecord,
    waitMs?: number,
  ): Promise<BindingScopeResetScopeResult> {
    const registry = await this.options.registry();
    const deadlineMs = this.options.timer.now() + clampWaitMs(waitMs);
    return this.invalidate(registry, scope, "incarnation_reset", deadlineMs);
  }

  private async invalidate(
    registry: BindingScopeResetRegistry,
    scope: BindingScopeRecord,
    reason: BindingScopeInvalidationReason,
    deadlineMs: number,
    force = false,
  ): Promise<BindingScopeResetScopeResult> {
    try {
      return await this.invalidateSteps(registry, scope, reason, deadlineMs, force);
    } catch (error) {
      if (classifySqliteError(error) === "retryable") {
        // Each reset write is idempotent; a repeated reset resumes any committed invalidation.
        throw new BindingDiscoveryIncompleteError(errorMessage(error));
      }
      throw error;
    }
  }

  private async invalidateSteps(
    registry: BindingScopeResetRegistry,
    scope: BindingScopeRecord,
    reason: BindingScopeInvalidationReason,
    deadlineMs: number,
    force = false,
  ): Promise<BindingScopeResetScopeResult> {
    const base = {
      scopeKey: scope.scopeKey,
      managedHostScope: scope.managedHostScope,
      runnerNamespace: scope.runnerNamespace,
      runnerIncarnation: scope.runnerIncarnation,
    };
    // Idempotent: blocks acquisitions now, and turns an abandoned (revivable) scope permanent.
    await registry.beginScopeInvalidation(scope.scopeKey, reason);
    let forceRefusals = force ? await this.abandonSettlement(registry, scope) : [];
    // `--force` judges each binding again once the settle wait is over (#11616): a verdict taken
    // before the wait is stale by then (the cap may have passed, the settler may have exited).
    let forceRejudged = !force;
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
      const remainingMs = deadlineMs - this.options.timer.now();
      if (remainingMs <= 0 && !forceRejudged) {
        forceRejudged = true;
        forceRefusals = await this.abandonSettlement(registry, scope);
        // One more completion pass: a binding abandoned just now no longer holds the scope.
        continue;
      }
      if (remainingMs <= 0) {
        return { ...base, ...pendingOutcome(completed, forceRefusals) };
      }
      await this.options.timer.sleep(Math.min(this.pollMs, remainingMs));
    }
  }

  /**
   * Return each `settling` binding of the scope with no live owner that is provably stuck to `ready`, committing
   * its release journal entry in the same transaction (the existing journal API, never by hand).
   * Stuck means the release outlived the settlement cap, the watcher's own "past cap" state
   * (#11539), or its settling daemon is provably gone (#11545). Every binding left alone is returned as a typed refusal saying why and what to do: a
   * binding with a live execution owner (in any state) is never touched and says so (#11545).
   */
  private async abandonSettlement(
    registry: BindingScopeResetRegistry,
    scope: BindingScopeRecord,
  ): Promise<BindingScopeResetForceRefusal[]> {
    const refusals: BindingScopeResetForceRefusal[] = [];
    for (const binding of await registry.listAssignments(scope.scopeKey)) {
      const refusal = await this.forceBinding(registry, binding);
      if (refusal) {
        refusals.push(refusal);
      }
    }
    return refusals;
  }

  /** Apply `--force` to one binding; resolves to why it was left alone, if it was. */
  private async forceBinding(
    registry: BindingScopeResetRegistry,
    binding: BindingAssignmentRecord,
  ): Promise<BindingScopeResetForceRefusal | undefined> {
    // An owner record dead by liveness (its clear failed) is not an execution in use (#11545).
    if (binding.execOwner !== null && this.isExecOwnerLive(binding.execOwner)) {
      return this.liveOwnerRefusal(binding, binding.execOwner);
    }
    if (binding.state !== "settling") {
      return undefined;
    }
    const label = `${binding.scopeKey}/${binding.bindingIndex}`;
    try {
      return await this.abandonSettlingBinding(registry, binding);
    } catch (error) {
      logger.warn(
        `[BindingScopeReset] --force could not abandon binding ${label}: ${errorMessage(error)}`,
        error,
      );
      return {
        bindingIndex: binding.bindingIndex,
        reason: "abandon_failed",
        message: `Binding ${label} could not be abandoned: ${errorMessage(error)}. Retry.`,
      };
    }
  }

  /**
   * The refusal for a binding whose owner record the liveness predicate counts as live. A record this
   * daemon wrote is judged by its session, and one whose process is gone can only be live because
   * this daemon holds its session: both are executions in use here. A record of another running
   * process is live by that process alone; whether its session ended there cannot be known from
   * this daemon, so the refusal says so instead of guessing either way.
   */
  private liveOwnerRefusal(
    binding: BindingAssignmentRecord,
    owner: BindingExecOwner,
  ): BindingScopeResetForceRefusal {
    const label = `${binding.scopeKey}/${binding.bindingIndex}`;
    const ownerProcess: BindingProcessIdentity = {
      daemonId: owner.daemonId,
      pid: owner.pid,
      processGenerationToken: owner.processGenerationToken,
    };
    if (owner.pid === this.thisPid || !this.isExecOwnerLive(ownerProcess)) {
      return {
        bindingIndex: binding.bindingIndex,
        reason: "live_owner",
        message:
          `Binding ${label} is in use by execution ${owner.sessionUuid}, which this daemon holds; ` +
          "--force never overrides an execution in use. Release that execution, then retry.",
      };
    }
    return {
      bindingIndex: binding.bindingIndex,
      reason: "owner_liveness_unknown",
      message:
        `Binding ${label} is owned by execution ${owner.sessionUuid} of another running daemon ` +
        `(${owner.daemonId}, pid ${owner.pid}). This daemon cannot tell whether that execution ` +
        "has ended there, so --force leaves the binding alone. Run the reset through that daemon, " +
        "or restart it (its record then reads dead), then retry.",
    };
  }

  /** Abandon one `settling` binding without a live owner, or say why not. May throw (registry). */
  private async abandonSettlingBinding(
    registry: BindingScopeResetRegistry,
    binding: BindingAssignmentRecord,
  ): Promise<BindingScopeResetForceRefusal | undefined> {
    const key = { scopeKey: binding.scopeKey, bindingIndex: binding.bindingIndex };
    const label = `${key.scopeKey}/${key.bindingIndex}`;
    const open = await registry.listOpenBindingJournal(key);
    const release = open.find((entry) => entry.kind === "release");
    if (open.some((entry) => entry.kind !== "release")) {
      return {
        bindingIndex: key.bindingIndex,
        reason: "other_open_journal",
        message:
          `Binding ${label} has unfinished non-release journal work; --force does not abandon it. ` +
          "Wait for the redrive to finish, then retry.",
      };
    }
    if (!release) {
      return {
        bindingIndex: key.bindingIndex,
        reason: "no_release_entry",
        message:
          `Binding ${label} is settling under ${describeSettler(binding.settler)} but has no open ` +
          "release journal entry, so --force cannot tell whether it is stuck and does not " +
          "abandon it. Wait for that daemon to return it to ready; if it does not, restart that " +
          "daemon (startup recovery returns a binding whose settler is gone to ready), then retry.",
      };
    }
    const remainingMs = release.createdAtMs + this.settlementCapMs - this.options.timer.now();
    const settlerGone = this.isSettlerProvablyDead(binding, release);
    if (remainingMs > 0 && !settlerGone) {
      return {
        bindingIndex: key.bindingIndex,
        reason: "within_settlement_cap",
        remainingMs,
        message:
          `Binding ${label} is still settling under ${describeSettler(binding.settler)}, which is not ` +
          "known to be gone, so its released work may be running. " +
          `Wait, or retry --force in ${remainingMs}ms once it outlives the settlement cap.`,
      };
    }
    const result = await registry.advanceBindingJournal(release.id, {
      owner: release.owner,
      expectedPhase: release.phase,
      phase: "committed",
      assignment: { kind: "state", expected: release.binding, state: "ready" },
    });
    if (result.kind === "advanced") {
      logger.warn(
        remainingMs > 0
          ? `[BindingScopeReset] --force abandoned the settlement of binding ${label}: its settling ` +
              `daemon is gone (${describeSettler(binding.settler)}), and its released work with it (#11545)`
          : `[BindingScopeReset] --force abandoned the settlement of binding ${label}, stuck past the ` +
              `${this.settlementCapMs}ms cap; its released work may still be running (#11336)`,
      );
      return undefined;
    }
    logger.warn(`[BindingScopeReset] --force could not abandon binding ${label}: ${result.kind}`);
    return {
      bindingIndex: key.bindingIndex,
      reason: "abandon_failed",
      message: `Binding ${label} changed while --force abandoned it (${result.kind}); retry.`,
    };
  }

  /**
   * Whether the daemon settling this binding is provably gone, by the same predicate the registry's
   * own recovery uses (`recoverSettledBindings`): the released work ran in that process and died with
   * it, so nothing is "settling normally" and the cap need not be waited out (#11545). Both the
   * binding's recorded settler and the release entry's current owner (a redriving daemon may have
   * taken the entry over) must be dead. A binding with no recorded settler, or a settler whose
   * liveness cannot be decided (the predicate keeps a possibly-live process), is not provably dead.
   */
  private isSettlerProvablyDead(
    binding: BindingAssignmentRecord,
    release: BindingJournalEntry,
  ): boolean {
    return (
      binding.settler !== null &&
      !this.isExecOwnerLive(binding.settler) &&
      !this.isExecOwnerLive(release.owner)
    );
  }
}

function describeSettler(settler: BindingProcessIdentity | null): string {
  return settler === null
    ? "an unrecorded settler"
    : `settling daemon ${settler.daemonId} (pid ${settler.pid})`;
}

/** The `pending` answer for a scope whose last completion pass did not invalidate it. */
function pendingOutcome(
  completed: CompleteScopeInvalidationResult,
  forceRefusals: BindingScopeResetForceRefusal[],
): Pick<BindingScopeResetScopeResult, "outcome" | "freedDevices" | "pending" | "forceRefusals"> {
  return {
    outcome: "pending",
    freedDevices: [],
    pending:
      completed.kind === "pending"
        ? pendingEvidence(completed)
        : { liveOwners: [], settling: [], cleanupPending: [], openJournal: [] },
    ...(forceRefusals.length > 0 ? { forceRefusals } : {}),
  };
}

function pendingEvidence(
  completed: Extract<CompleteScopeInvalidationResult, { kind: "pending" }>,
): NonNullable<BindingScopeResetScopeResult["pending"]> {
  const bindingRef = (binding: BindingAssignmentRecord): BindingScopeResetPendingCleanup => ({
    bindingIndex: binding.bindingIndex,
    platform: binding.platform,
    stableDeviceId: binding.stableDeviceId,
  });
  return {
    liveOwners: completed.liveOwners.flatMap((binding) =>
      binding.execOwner
        ? [
            {
              bindingIndex: binding.bindingIndex,
              sessionUuid: binding.execOwner.sessionUuid,
              pid: binding.execOwner.pid,
            },
          ]
        : [],
    ),
    settling: completed.settling.map(bindingRef),
    cleanupPending: completed.cleanupPending.map(bindingRef),
    openJournal: completed.openJournal.map((entry) => ({
      bindingIndex: entry.bindingIndex,
      entryId: entry.id,
      kind: entry.kind,
      phase: entry.phase,
    })),
  };
}

function clampWaitMs(waitMs: number | undefined): number {
  if (waitMs === undefined || !Number.isFinite(waitMs) || waitMs < 0) {
    return BINDING_SCOPE_RESET_DEFAULT_WAIT_MS;
  }
  return Math.min(waitMs, BINDING_SCOPE_RESET_MAX_WAIT_MS);
}
