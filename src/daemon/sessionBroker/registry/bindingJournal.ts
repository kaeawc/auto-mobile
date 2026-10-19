import type { DeviceInfo } from "../../../models/index";
import {
  androidBindingSpecSchema,
  iosBindingSpecSchema,
} from "../../../utils/provisionDeviceSpecSchemas";
import {
  exponentialBackoff,
  normalizeBackoff,
  type BackoffInput,
  type BackoffPolicy,
} from "../../../utils/Backoff";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import type { Timer } from "../../../utils/SystemTimer";
import type {
  BindingDeletionResult,
  BindingDeviceClaims,
  BindingDeviceDeleter,
  BindingInventory,
  BindingRequestedSpec,
  ManagedSpecMatcher,
} from "../provisioning/reconciler";
import { RegistryRetryPacing } from "./registryRetryPacing";
import { defaultBindingExecOwnerLiveness } from "./ownerLiveness";
import {
  journalOwnersEqual,
  sameBinding,
  type AdvanceBindingJournalInput,
  type BindingAssignmentRecord,
  type BindingBindingCommit,
  type BindingExecOwnerLiveness,
  type BindingJournalEntry,
  type BindingJournalOwner,
  type BindingJournalPhase,
  type BindingKey,
  type BindingRegistry,
  journalCreationPlatform,
} from "./bindingRegistry";
import { BindingJournalRemovalRegistryTimeout } from "./BindingJournalRemovalRegistryTimeout";
import { BindingJournalDriveCancelled } from "./BindingJournalDriveCancelled";
import { BindingJournalInFlight } from "./BindingJournalInFlight";
import { BindingJournalDeviceLocator } from "./BindingJournalDeviceLocator";
import { BindingJournalRemovalFlags } from "./BindingJournalRemovalFlags";
import { BindingJournalStageRunner } from "./BindingJournalStageRunner";
import {
  BINDING_JOURNAL_MAX_ABANDONED_DELETES,
  BINDING_JOURNAL_OVERDUE_DELETE_GRACE_MS,
  BINDING_JOURNAL_REMOVAL_FLAG_MAX_ATTEMPTS,
  BINDING_JOURNAL_REMOVAL_FLAG_WRITE_BUDGET_MS,
  checkCancellation,
} from "./bindingJournalSupport";

export {
  BindingJournalInFlight,
  BindingJournalRemovalRegistryTimeout,
  BINDING_JOURNAL_MAX_ABANDONED_DELETES,
  BINDING_JOURNAL_OVERDUE_DELETE_GRACE_MS,
  BINDING_JOURNAL_REMOVAL_FLAG_MAX_ATTEMPTS,
  BINDING_JOURNAL_REMOVAL_FLAG_WRITE_BUDGET_MS,
};

/**
 * Journal redrive for managed device bindings (#11179, epic #11172).
 *
 * Every create, replace and unsettled release of a binding is recorded in `slot_journal` with the exact
 * devices it acts on, and every phase change shares a transaction with the assignment change it
 * implies. When a process dies mid-work, the entry stays open. A redrive — at daemon startup, at the
 * binding's next acquisition, or from a periodic pass — adopts entries whose owner is dead and drives
 * them to convergence against the recorded targets:
 *
 * - `deleting`: delete and verify absence of the recorded old device, only while the binding still
 *   holds the entry's exact binding; then record the empty binding (`deleted`).
 * - `deleted`: the destructive part is done; the entry commits and the next acquisition creates.
 * - `creating` / `created`: discover the recorded new device by stable id or generated name. An
 *   unheld, matching device is adopted into the binding unless removal was durably requested;
 *   requested removals, mismatching or superseded devices are deleted;
 *   proven absence rolls the entry back.
 * - `release` (`intent`): a drain's `settling` mark. Once its settler is dead and the device is
 *   free of live claims, return the binding to `ready` (or close the entry if the binding already
 *   settled, e.g. through `recoverSettledBindings`).
 *
 * Safety: a device bound to another binding, another generation, or the free pool is never deleted or
 * rewritten; partial inventory or an unreadable configuration is never absence; a failed attempt is
 * recorded with backoff and retried later, never abandoned. Creation is never redriven without a
 * caller: an empty binding is filled by its next acquisition.
 */

/** Delete budget for a redrive step that has no caller deadline. */
export const BINDING_JOURNAL_STEP_BUDGET_MS = 120_000;
export const BINDING_JOURNAL_DISCOVERY_BUDGET_MS = 30_000;
export const BINDING_JOURNAL_CLAIM_BUDGET_MS = 10_000;
export const BINDING_JOURNAL_MATCH_BUDGET_MS = 10_000;
export const BINDING_JOURNAL_DELETE_GRACE_MS = 5_000;
export const BINDING_JOURNAL_STOP_BUDGET_MS = 100;
export const BINDING_JOURNAL_REGISTRY_RETRY_INITIAL_DELAY_MS = 25;
export const BINDING_JOURNAL_REGISTRY_RETRY_MAX_DELAY_MS = 1_000;
export const BINDING_JOURNAL_REGISTRY_RETRY_MAX_BLOCKED_WAIT_MS = 5_000;

export interface BindingJournalStageBudgets {
  discoveryMs: number;
  claimMs: number;
  matchMs: number;
  deleteGraceMs: number;
}

interface DriveOptions {
  signal?: AbortSignal;
}

/** Bound on phase transitions one drive performs (each phase moves strictly forward). */
const MAX_STEPS_PER_DRIVE = 6;

export const DEFAULT_BINDING_JOURNAL_BACKOFF = exponentialBackoff({
  initialDelayMs: 1_000,
  multiplier: 2,
  maxDelayMs: 60_000,
});

export type BindingJournalOwnerLiveness = (owner: BindingJournalOwner) => boolean;

export interface BindingJournalDependencies {
  registry: BindingRegistry;
  inventory: BindingInventory;
  matcher: ManagedSpecMatcher;
  deleter: BindingDeviceDeleter;
  claims: BindingDeviceClaims;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  stageBudgets?: Partial<BindingJournalStageBudgets>;
  /** This process's identity as a journal owner. */
  owner: BindingJournalOwner;
  /** Whether another owner is still driving its entries; default: its PID is running. */
  isOwnerLive?: BindingJournalOwnerLiveness;
  isExecOwnerLive?: BindingExecOwnerLiveness;
  inFlight?: BindingJournalInFlight;
  backoff?: BackoffInput;
  isBusy?: (device: DeviceInfo) => string | undefined;
}

export type BindingJournalBlockReason =
  | "discovery_incomplete"
  | "device_busy"
  | "cleanup_pending"
  | "binding_settling"
  | "binding_in_use"
  | "reconcile_in_progress"
  | "scope_not_valid";

/** Summary of one redrive, for acquisition evidence and logs. */
export interface BindingJournalRedriveRecord {
  entryId: number;
  kind: BindingJournalEntry["kind"];
  phase: BindingJournalPhase;
  outcome: "settled" | "blocked";
  reason?: BindingJournalBlockReason;
}

export type BindingRedriveResult =
  | { kind: "clear"; redriven: BindingJournalRedriveRecord[] }
  | {
      kind: "blocked";
      reason: BindingJournalBlockReason;
      message: string;
      entry: BindingJournalEntry;
      redriven: BindingJournalRedriveRecord[];
    };

export interface BindingJournalPassResult {
  settled: BindingJournalRedriveRecord[];
  blocked: BindingJournalRedriveRecord[];
  /** Entries left to their live owner, in flight here, or not yet due. */
  skipped: number;
}

export interface DeletionStepOptions {
  /** Present when the caller already proved the device listed and unclaimed. */
  device?: DeviceInfo;
  deadlineMs?: number;
  /** Cancels only the delete stage; an unverified delete is recorded for retry. */
  signal?: AbortSignal;
}

export type DeletionStepResult =
  | {
      kind: "deleted";
      entry: BindingJournalEntry;
      assignment: BindingAssignmentRecord;
      evidence?: unknown;
    }
  | {
      kind: "blocked";
      entry: BindingJournalEntry;
      reason: BindingJournalBlockReason;
      message: string;
      evidence?: unknown;
    };

type Step =
  | { kind: "next"; entry: BindingJournalEntry }
  | { kind: "settled"; entry: BindingJournalEntry }
  | {
      kind: "blocked";
      entry: BindingJournalEntry;
      reason: BindingJournalBlockReason;
      message: string;
    };

function blocked(
  entry: BindingJournalEntry,
  reason: BindingJournalBlockReason,
  message: string,
): Extract<Step, { kind: "blocked" }> {
  return { kind: "blocked", entry, reason, message };
}

function keyOf(entry: BindingKey): BindingKey {
  return { scopeKey: entry.scopeKey, bindingIndex: entry.bindingIndex };
}

export class BindingJournal {
  readonly inFlight: BindingJournalInFlight;
  private readonly isOwnerLive: BindingJournalOwnerLiveness;
  private readonly isExecOwnerLive: BindingExecOwnerLiveness;
  private readonly backoff: BackoffPolicy;
  private readonly budgets: BindingJournalStageBudgets;
  private readonly removalFlags: BindingJournalRemovalFlags;
  private readonly stages: BindingJournalStageRunner;
  private readonly locator: BindingJournalDeviceLocator;

  constructor(private readonly deps: BindingJournalDependencies) {
    this.inFlight = deps.inFlight ?? new BindingJournalInFlight();
    this.isOwnerLive = deps.isOwnerLive ?? defaultBindingExecOwnerLiveness;
    this.isExecOwnerLive = deps.isExecOwnerLive ?? defaultBindingExecOwnerLiveness;
    this.backoff = normalizeBackoff(deps.backoff ?? DEFAULT_BINDING_JOURNAL_BACKOFF);
    this.budgets = {
      discoveryMs: BINDING_JOURNAL_DISCOVERY_BUDGET_MS,
      claimMs: BINDING_JOURNAL_CLAIM_BUDGET_MS,
      matchMs: BINDING_JOURNAL_MATCH_BUDGET_MS,
      deleteGraceMs: BINDING_JOURNAL_DELETE_GRACE_MS,
      ...deps.stageBudgets,
    };
    this.removalFlags = new BindingJournalRemovalFlags({
      timer: deps.timer,
      pacing: new RegistryRetryPacing({
        timer: deps.timer,
        initialDelayMs: BINDING_JOURNAL_REGISTRY_RETRY_INITIAL_DELAY_MS,
        maxDelayMs: BINDING_JOURNAL_REGISTRY_RETRY_MAX_DELAY_MS,
        maxBlockedWaitMs: BINDING_JOURNAL_REGISTRY_RETRY_MAX_BLOCKED_WAIT_MS,
      }),
      advance: (entry, input, signal) => this.advanceStep(entry, input, signal),
    });
    this.stages = new BindingJournalStageRunner({
      inventory: deps.inventory,
      deleter: deps.deleter,
      claims: deps.claims,
      timer: deps.timer,
      inFlight: this.inFlight,
      budgets: this.budgets,
    });
    this.locator = new BindingJournalDeviceLocator(deps.registry, this.stages);
  }

  get owner(): BindingJournalOwner {
    return this.deps.owner;
  }

  markRemovalIntended(entry: BindingJournalEntry): void {
    this.removalFlags.markRemovalIntended(entry);
  }

  requestRemoval(
    entry: BindingJournalEntry,
    options: { deadlineMs?: number; signal?: AbortSignal } = {},
  ): Promise<BindingJournalEntry> {
    return this.removalFlags.requestRemoval(entry, options);
  }

  /**
   * Redrive one binding before an acquisition reconciles it. `clear` means no unfinished journaled
   * work remains (the binding may have changed: re-read it); `blocked` names why it cannot proceed.
   */
  async redriveBinding(key: BindingKey, options: DriveOptions = {}): Promise<BindingRedriveResult> {
    try {
      return await this.redriveBindingEntries(key, options.signal);
    } catch (error) {
      if (error instanceof BindingJournalDriveCancelled) {
        // Caller cancellation leaves durable cleanup for its next owner.
        logger.debug("[BindingJournal] acquisition redrive cancelled");
        throw error.reason;
      }
      // Registry failures retain their identity for callers that classify them.
      throw error;
    }
  }

  private async redriveBindingEntries(
    key: BindingKey,
    signal?: AbortSignal,
  ): Promise<BindingRedriveResult> {
    checkCancellation(signal);
    const redriven: BindingJournalRedriveRecord[] = [];
    let open = await this.deps.registry.listOpenBindingJournal(key);
    checkCancellation(signal);
    if (open.length === 0) {
      const synthesized = await this.adoptUnjournaledWork(key, signal);
      open = synthesized ? [synthesized] : [];
    }
    for (const entry of open) {
      const result = await this.driveEntry(entry, signal);
      if (result.kind === "skipped") {
        return {
          kind: "blocked",
          reason: skippedReason(result.entry),
          message: `Binding ${key.bindingIndex} has unfinished ${result.entry.kind} work (${result.why}).`,
          entry: result.entry,
          redriven,
        };
      }
      redriven.push(toRecord(result));
      if (result.kind === "blocked") {
        return {
          kind: "blocked",
          reason: result.reason,
          message: result.message,
          entry: result.entry,
          redriven,
        };
      }
    }
    return { kind: "clear", redriven };
  }

  /**
   * One fair pass over every open entry (daemon startup and the periodic owner loop): each due entry
   * whose owner is dead gets one drive; failures back off and stay open.
   */
  async runPass(options: DriveOptions = {}): Promise<BindingJournalPassResult> {
    const { signal } = options;
    const pass: BindingJournalPassResult = {
      settled: [],
      blocked: [],
      skipped: 0,
    };
    if (signal?.aborted) {
      return pass;
    }
    const open = await this.deps.registry.listOpenBindingJournal();
    for (const entry of open) {
      if (signal?.aborted) {
        break;
      }
      try {
        const result = await this.driveEntry(entry, signal, { fromPass: true });
        if (result.kind === "skipped") {
          pass.skipped += 1;
        } else {
          (result.kind === "settled" ? pass.settled : pass.blocked).push(toRecord(result));
        }
      } catch (error) {
        if (error instanceof BindingJournalDriveCancelled) {
          // Stop is expected; leave the entry open without counting a failed attempt.
          logger.debug("[BindingJournal] pass cancelled");
          break;
        }
        // One entry's failure must not starve the others; it stays open for the next pass.
        logger.warn(
          `[BindingJournal] redrive of entry ${entry.id} failed: ${errorMessage(error)}`,
          error,
        );
        pass.blocked.push({
          entryId: entry.id,
          kind: entry.kind,
          phase: entry.phase,
          outcome: "blocked",
        });
      }
    }
    return pass;
  }

  /**
   * Delete and verify absence of a `deleting` entry's old device, then record the empty binding in
   * the same transaction as the `deleted` phase. A failure marks the binding `cleanup_pending` and
   * schedules a retry; the entry stays open.
   */
  async driveDeletion(
    entry: BindingJournalEntry,
    options: DeletionStepOptions = {},
  ): Promise<DeletionStepResult | Extract<Step, { kind: "settled" }>> {
    const pending = entry.target.oldStableId
      ? this.pendingRemoval(entry, entry.platform, entry.target.oldStableId)
      : undefined;
    return pending ?? this.deletionStep(entry, options);
  }

  private async deletionStep(
    entry: BindingJournalEntry,
    options: DeletionStepOptions,
    signal?: AbortSignal,
  ): Promise<DeletionStepResult | Extract<Step, { kind: "settled" }>> {
    checkCancellation(signal);
    const oldId = entry.target.oldStableId;
    const assignment = await this.deps.registry.getAssignment(keyOf(entry));
    checkCancellation(signal);
    if (!oldId || !assignment || !sameBinding(assignment, entry.binding)) {
      // The binding moved on: its device may now be someone else's, so delete nothing.
      return this.closeStep(entry, "rolled_back", signal);
    }
    if (assignment.execOwner && this.isExecOwnerLive(assignment.execOwner)) {
      return blocked(
        entry,
        "binding_in_use",
        `Binding is held by ${assignment.execOwner.sessionUuid}.`,
      );
    }
    const pending = this.pendingRemoval(entry, entry.platform, oldId, "step");
    if (pending) {
      return pending;
    }
    const located = options.device
      ? { kind: "present" as const, device: options.device }
      : await this.locator.locateForDeletion(entry, oldId, signal);
    if (located.kind === "blocked") {
      return this.recordBlocked(entry, located.reason, located.message, undefined, signal);
    }
    const deletion: BindingDeletionResult =
      located.kind === "present"
        ? await this.stages.deleteDevice(
            {
              platform: entry.platform,
              stableId: oldId,
              name: entry.target.oldName,
              deadlineMs:
                options.deadlineMs ?? this.deps.timer.now() + BINDING_JOURNAL_STEP_BUDGET_MS,
              signal: options.signal,
            },
            signal,
          )
        : { kind: "absent", evidence: { listed: false } };
    checkCancellation(signal);
    return this.recordDeletion(entry, oldId, deletion, signal);
  }

  /** Record a deletion outcome: the empty binding with `deleted`, or `cleanup_pending` and a retry. */
  private async recordDeletion(
    entry: BindingJournalEntry,
    oldId: string,
    deletion: BindingDeletionResult,
    signal?: AbortSignal,
  ): Promise<DeletionStepResult> {
    if (deletion.kind === "failed") {
      const pending = await this.advanceStep(
        entry,
        {
          expectedPhase: "deleting",
          phase: "deleting",
          assignment: { kind: "state", expected: entry.binding, state: "cleanup_pending" },
          attempt: this.attemptAfter(entry, deletion.message, this.entryRemovalInFlight(entry)),
        },
        signal,
      );
      return {
        kind: "blocked",
        entry: pending.kind === "advanced" ? pending.entry : entry,
        reason: "cleanup_pending",
        message: `Deleting device '${oldId}' failed: ${deletion.message}`,
        evidence: deletion.evidence,
      };
    }
    const emptied = await this.advanceStep(
      entry,
      {
        expectedPhase: "deleting",
        phase: "deleted",
        assignment: {
          kind: "commit",
          expected: entry.binding,
          // A cross-platform replacement moves the emptied binding to the new platform (#11232).
          next: {
            ...emptyBindingCommit(entry.target.requestedSpec),
            platform: journalCreationPlatform(entry),
          },
        },
      },
      signal,
    );
    if (emptied.kind !== "advanced" || !emptied.assignment) {
      return {
        kind: "blocked",
        entry,
        reason: "reconcile_in_progress",
        message: `Recording the deletion failed: ${emptied.kind}.`,
      };
    }
    return {
      kind: "deleted",
      entry: emptied.entry,
      assignment: emptied.assignment,
      evidence: deletion.evidence,
    };
  }

  /**
   * Settle a `creating`/`created` entry: adopt its recorded device when the binding still holds the
   * entry's binding and the device matches (`adopt`), otherwise remove it. Proven absence rolls the
   * entry back.
   */
  async settleCreation(
    entry: BindingJournalEntry,
    options: { adopt: boolean; deadlineMs?: number } = { adopt: true },
  ): Promise<Step> {
    const pending = entry.target.newStableId
      ? this.pendingRemoval(entry, journalCreationPlatform(entry), entry.target.newStableId)
      : undefined;
    return pending ?? this.creationStep(entry, options);
  }

  /** Registry work cannot hold an uncommitted cleanup beyond its request or fixed write cap. */
  async removalRegistryStage<T>(operation: () => Promise<T>, deadlineMs?: number): Promise<T> {
    const timeoutMs = Math.min(
      BINDING_JOURNAL_REMOVAL_FLAG_WRITE_BUDGET_MS,
      deadlineMs === undefined ? Infinity : Math.max(0, deadlineMs - this.deps.timer.now()),
    );
    return raceWithDeadline(operation, {
      timer: this.deps.timer,
      timeoutMs,
      label: "uncommitted cleanup registry stage",
      timeoutError: () =>
        new BindingJournalRemovalRegistryTimeout(
          "Removal deferred to journal redrive: registry stage timed out.",
        ),
    });
  }

  private async creationStep(
    entry: BindingJournalEntry,
    options: { adopt: boolean; deadlineMs?: number },
    signal?: AbortSignal,
  ): Promise<Step> {
    try {
      return await this.creationRegistryStep(entry, options, signal);
    } catch (error) {
      if (!(error instanceof BindingJournalRemovalRegistryTimeout)) {
        throw error;
      }
      const message = options.adopt
        ? `Settling created entry ${entry.id} deferred to the next redrive: registry stage timed out`
        : "Creation cleanup deferred to journal redrive: registry stage timed out";
      logger.warn(`[BindingJournal] ${message}`, error);
      return blocked(entry, "reconcile_in_progress", message);
    }
  }

  private async creationRegistryStep(
    entry: BindingJournalEntry,
    options: { adopt: boolean; deadlineMs?: number },
    signal?: AbortSignal,
  ): Promise<Step> {
    checkCancellation(signal);
    const located = await this.locator.locateCreated(entry, signal);
    if (located.kind === "absent") {
      return this.removalRegistryStage(
        () => this.closeStep(entry, "rolled_back", signal),
        options.deadlineMs,
      );
    }
    if (located.kind === "blocked") {
      return this.removalBlocked(
        entry,
        located.reason,
        located.message,
        undefined,
        signal,
        options.deadlineMs,
      );
    }
    const { device, stableId } = located;
    const locatedPending = this.pendingRemoval(
      entry,
      journalCreationPlatform(entry),
      stableId,
      "step",
    );
    if (locatedPending) {
      return locatedPending;
    }
    const holder = await this.removalRegistryStage(
      () => this.deps.registry.findDeviceHolder(journalCreationPlatform(entry), stableId),
      options.deadlineMs,
    );
    checkCancellation(signal);
    if (holder) {
      // Bound to a binding or parked in the free pool: never ours to adopt or delete.
      return this.removalRegistryStage(
        () => this.closeStep(entry, "rolled_back", signal),
        options.deadlineMs,
      );
    }
    const assignment = await this.removalRegistryStage(
      () => this.deps.registry.getAssignment(keyOf(entry)),
      options.deadlineMs,
    );
    checkCancellation(signal);
    const current = assignment !== null && sameBinding(assignment, entry.binding);
    const spec = recordedSpec(entry);
    if (options.adopt && !this.removalFlags.removalIntended(entry) && current && spec) {
      const match = await this.stages.boundedStage(
        () => this.deps.matcher.matches(device, spec),
        {
          label: `configuration for entry ${entry.id}`,
          timeoutMs: this.budgets.matchMs,
          signal,
          cancel: signal,
        },
        () => "unknown",
      );
      if (match === "unknown") {
        return this.recordBlocked(
          entry,
          "discovery_incomplete",
          `Configuration of '${stableId}' is unreadable.`,
          undefined,
          signal,
        );
      }
      if (match === "match") {
        return this.adoptCreated(entry, device, stableId, signal);
      }
    }
    return this.removeCreated(entry, device, stableId, options.deadlineMs, signal);
  }

  /** Close an entry at a terminal phase (no assignment change). */
  async close(
    entry: BindingJournalEntry,
    phase: "committed" | "rolled_back",
  ): Promise<Extract<Step, { kind: "settled" }>> {
    return this.closeStep(entry, phase);
  }

  private async closeStep(
    entry: BindingJournalEntry,
    phase: "committed" | "rolled_back",
    signal?: AbortSignal,
  ): Promise<Extract<Step, { kind: "settled" }>> {
    const closed = await this.advanceStep(entry, { expectedPhase: entry.phase, phase }, signal);
    this.removalFlags.clear(entry.id);
    return { kind: "settled", entry: closed.kind === "advanced" ? closed.entry : entry };
  }

  async advance(entry: BindingJournalEntry, input: Omit<AdvanceBindingJournalInput, "owner">) {
    const result = await this.advanceStep(entry, input);
    if (
      result.kind === "journal_conflict" ||
      (result.kind === "advanced" && result.entry.target.removalRequested)
    ) {
      this.removalFlags.clear(entry.id);
    }
    return result;
  }

  private async advanceStep(
    entry: BindingJournalEntry,
    input: Omit<AdvanceBindingJournalInput, "owner">,
    signal?: AbortSignal,
  ) {
    checkCancellation(signal);
    const result = await this.deps.registry.advanceBindingJournal(entry.id, {
      ...input,
      owner: this.deps.owner,
    });
    checkCancellation(signal);
    return result;
  }

  // --- driving -------------------------------------------------------------------------------

  private async driveEntry(
    initial: BindingJournalEntry,
    signal?: AbortSignal,
    options: { fromPass?: boolean } = {},
  ): Promise<
    | Extract<Step, { kind: "settled" | "blocked" }>
    | { kind: "skipped"; entry: BindingJournalEntry; why: string }
  > {
    checkCancellation(signal);
    if (this.inFlight.has(initial.id)) {
      return (
        (!options.fromPass && this.pendingEntryRemoval(initial)) || {
          kind: "skipped",
          entry: initial,
          why: "in progress in this process",
        }
      );
    }
    const owned = await this.takeOwnership(initial, signal);
    if (owned.kind === "skipped") {
      return owned;
    }
    let entry = owned.entry;
    const pending = this.pendingEntryRemoval(entry, options.fromPass);
    if (pending) {
      return pending;
    }
    // Fair, finite retries: a failed attempt waits out its backoff, whoever asks next.
    if (entry.attempts > 0 && entry.nextAttemptAtMs > this.deps.timer.now()) {
      return {
        kind: "skipped",
        entry,
        why: `retry due in ${entry.nextAttemptAtMs - this.deps.timer.now()}ms`,
      };
    }
    this.inFlight.add(entry.id);
    try {
      for (let step = 0; step < MAX_STEPS_PER_DRIVE; step += 1) {
        checkCancellation(signal);
        const result = await this.step(entry, signal);
        if (result.kind !== "next") {
          return result;
        }
        entry = result.entry;
      }
      return blocked(entry, "reconcile_in_progress", "Journal entry did not settle.");
    } finally {
      this.inFlight.delete(entry.id);
    }
  }

  private async takeOwnership(
    entry: BindingJournalEntry,
    signal?: AbortSignal,
  ): Promise<
    | { kind: "owned"; entry: BindingJournalEntry }
    | { kind: "skipped"; entry: BindingJournalEntry; why: string }
  > {
    if (journalOwnersEqual(entry.owner, this.deps.owner)) {
      // Ours but not in flight: the step that opened it aborted. Resume it.
      return { kind: "owned", entry };
    }
    if (this.isOwnerLive(entry.owner)) {
      return { kind: "skipped", entry, why: `owned by live daemon ${entry.owner.daemonId}` };
    }
    const claimed = await this.deps.registry.claimBindingJournal(
      entry.id,
      entry.owner,
      this.deps.owner,
    );
    checkCancellation(signal);
    if (claimed.kind !== "claimed") {
      return { kind: "skipped", entry: claimed.entry ?? entry, why: "claimed by another redrive" };
    }
    logger.info(
      `[BindingJournal] adopted ${entry.kind} entry ${entry.id} (${entry.phase}) of binding ` +
        `${entry.scopeKey.slice(0, 8)}/${entry.bindingIndex} from dead owner ${entry.owner.daemonId}`,
    );
    return { kind: "owned", entry: claimed.entry };
  }

  private async step(entry: BindingJournalEntry, signal?: AbortSignal): Promise<Step> {
    if (entry.kind === "release") {
      return this.settleRelease(entry, signal);
    }
    switch (entry.phase) {
      case "deleting": {
        const result = await this.deletionStep(entry, { signal }, signal);
        return result.kind === "deleted" ? { kind: "next", entry: result.entry } : result;
      }
      case "deleted":
        // Destructive work is done; the binding is empty and its next acquisition creates.
        return this.closeStep(entry, "committed", signal);
      case "intent":
      case "creating":
      case "created":
        return this.creationStep(entry, { adopt: true }, signal);
      default:
        return { kind: "settled", entry };
    }
  }

  // --- release -------------------------------------------------------------------------------

  private async settleRelease(entry: BindingJournalEntry, signal?: AbortSignal): Promise<Step> {
    const assignment = await this.deps.registry.getAssignment(keyOf(entry));
    checkCancellation(signal);
    if (!assignment || !sameBinding(assignment, entry.binding)) {
      return this.closeStep(entry, "rolled_back", signal);
    }
    if (assignment.state !== "settling") {
      // Already settled (by its watcher, or by `recoverSettledBindings`).
      return this.closeStep(entry, "committed", signal);
    }
    if (assignment.settler && this.isOwnerLive(assignment.settler)) {
      return blocked(
        entry,
        "binding_settling",
        "The binding's settler is still watching its work.",
      );
    }
    if (assignment.execOwner && this.isExecOwnerLive(assignment.execOwner)) {
      return blocked(
        entry,
        "binding_in_use",
        `Binding is held by ${assignment.execOwner.sessionUuid}.`,
      );
    }
    const stableId = assignment.stableDeviceId;
    if (stableId) {
      const free = await this.locator.checkDeviceFree(entry, stableId, signal);
      if (free.kind === "blocked") {
        return this.recordBlocked(entry, free.reason, free.message, undefined, signal);
      }
    }
    const restored = await this.advanceStep(
      entry,
      {
        expectedPhase: entry.phase,
        phase: "committed",
        assignment: { kind: "state", expected: entry.binding, state: "ready" },
      },
      signal,
    );
    if (restored.kind !== "advanced") {
      return blocked(
        entry,
        "reconcile_in_progress",
        `Restoring the binding failed: ${restored.kind}.`,
      );
    }
    return { kind: "settled", entry: restored.entry };
  }

  private async adoptCreated(
    entry: BindingJournalEntry,
    device: DeviceInfo,
    stableId: string,
    signal?: AbortSignal,
  ): Promise<Step> {
    if (this.removalFlags.removalIntended(entry)) {
      return this.removeCreated(entry, device, stableId, undefined, signal);
    }
    // Readiness is unproven after an interruption: bind as `provisioning`; the acquisition's reuse
    // path re-provisions it to automation readiness before anyone may claim it.
    const adopted = await this.advanceStep(
      entry,
      {
        expectedPhase: entry.phase,
        phase: "committed",
        target: { newStableId: stableId, newName: device.name },
        assignment: {
          kind: "commit",
          expected: entry.binding,
          next: {
            stableDeviceId: stableId,
            deviceName: device.name,
            requestedSpec: entry.target.requestedSpec,
            resolvedSpec: entry.target.resolvedSpec,
            specFingerprint: entry.target.specFingerprint,
            state: "provisioning",
          },
        },
      },
      signal,
    );
    if (adopted.kind === "advanced") {
      return { kind: "settled", entry: adopted.entry };
    }
    if (adopted.kind === "journal_conflict") {
      return blocked(entry, "reconcile_in_progress", "The journal entry changed during adoption.");
    }
    // The binding moved on underneath: the device is now an orphan of this entry.
    return this.removeCreated(entry, device, stableId, undefined, signal);
  }

  private async removeCreated(
    entry: BindingJournalEntry,
    device: DeviceInfo,
    stableId: string,
    deadlineMs?: number,
    signal?: AbortSignal,
  ): Promise<Step> {
    if (!entry.target.removalRequested) {
      this.markRemovalIntended(entry);
      const recorded = await this.removalRegistryStage(
        () =>
          this.advanceStep(
            entry,
            {
              expectedPhase: entry.phase,
              phase: entry.phase,
              target: { removalRequested: true, newStableId: stableId },
            },
            signal,
          ),
        deadlineMs,
      );
      if (recorded.kind === "advanced" || recorded.kind === "journal_conflict") {
        this.removalFlags.clear(entry.id);
      }
      if (recorded.kind !== "advanced") {
        return blocked(
          entry,
          "reconcile_in_progress",
          `Recording removal of '${stableId}' failed: ${recorded.kind}.`,
        );
      }
      entry = recorded.entry;
    }
    const claim = await this.stages.describeClaim(entry, device, signal);
    if (claim.kind !== "free") {
      return this.removalBlocked(
        entry,
        claim.kind === "held" ? "device_busy" : "discovery_incomplete",
        `Uncommitted device '${stableId}' cannot be removed: ${claim.reason}`,
        { newStableId: stableId },
        signal,
        deadlineMs,
      );
    }
    const deletion = await this.stages.deleteDevice(
      {
        platform: journalCreationPlatform(entry),
        stableId,
        name: device.name,
        deadlineMs: deadlineMs ?? this.deps.timer.now() + BINDING_JOURNAL_STEP_BUDGET_MS,
        signal,
      },
      signal,
    );
    if (deletion.kind === "failed") {
      return this.removalBlocked(
        entry,
        "cleanup_pending",
        `Removing uncommitted device '${stableId}' failed: ${deletion.message}`,
        { newStableId: stableId },
        signal,
        deadlineMs,
      );
    }
    const closed = await this.removalRegistryStage(
      () =>
        this.advanceStep(
          entry,
          {
            expectedPhase: entry.phase,
            phase: "rolled_back",
            target: { newStableId: stableId },
          },
          signal,
        ),
      deadlineMs,
    );
    this.removalFlags.clear(entry.id);
    return { kind: "settled", entry: closed.kind === "advanced" ? closed.entry : entry };
  }

  // --- legacy rows ---------------------------------------------------------------------------

  /**
   * A binding left `replacing` or `cleanup_pending` (a failed deletion) with no open entry — written
   * before the journal existed — gets a `deleting` entry, so its accepted deletion is redriven like
   * any other. `settling` bindings are recovered by their settler rule (`recoverSettledBindings`).
   */
  private async adoptUnjournaledWork(
    key: BindingKey,
    signal?: AbortSignal,
  ): Promise<BindingJournalEntry | null> {
    const assignment = await this.deps.registry.getAssignment(key);
    checkCancellation(signal);
    if (
      !assignment?.stableDeviceId ||
      (assignment.state !== "replacing" && assignment.state !== "cleanup_pending") ||
      (assignment.execOwner && this.isExecOwnerLive(assignment.execOwner))
    ) {
      return null;
    }
    const opened = await this.deps.registry.openBindingJournal(key, {
      kind: "replace",
      phase: "deleting",
      owner: this.deps.owner,
      target: {
        oldStableId: assignment.stableDeviceId,
        oldName: assignment.deviceName,
        newName: null,
        newStableId: null,
        requestedSpec: assignment.requestedSpec,
        resolvedSpec: assignment.resolvedSpec,
        specFingerprint: assignment.specFingerprint,
      },
      assignment: {
        kind: "state",
        expected: { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
        state: assignment.state,
      },
    });
    checkCancellation(signal);
    if (opened.kind === "opened") {
      logger.warn(
        `[BindingJournal] binding ${key.bindingIndex} was left ${assignment.state} without a journal entry; ` +
          `redriving it as entry ${opened.entry.id}`,
      );
      return opened.entry;
    }
    return opened.kind === "journal_open" ? opened.entry : null;
  }

  // --- shared --------------------------------------------------------------------------------

  private removalBlocked(
    entry: BindingJournalEntry,
    reason: BindingJournalBlockReason,
    message: string,
    target?: Partial<BindingJournalEntry["target"]>,
    signal?: AbortSignal,
    deadlineMs?: number,
  ) {
    return this.removalRegistryStage(
      () => this.recordBlocked(entry, reason, message, target, signal),
      deadlineMs,
    );
  }

  private async recordBlocked(
    entry: BindingJournalEntry,
    reason: BindingJournalBlockReason,
    message: string,
    target?: Partial<BindingJournalEntry["target"]>,
    signal?: AbortSignal,
  ): Promise<Extract<Step, { kind: "blocked" }>> {
    const phase: BindingJournalPhase =
      target?.newStableId && entry.phase === "creating" ? "created" : entry.phase;
    const recorded = await this.advanceStep(
      entry,
      {
        expectedPhase: entry.phase,
        phase,
        ...(target ? { target } : {}),
        attempt: this.attemptAfter(entry, message, this.entryRemovalInFlight(entry)),
      },
      signal,
    );
    return blocked(recorded.kind === "advanced" ? recorded.entry : entry, reason, message);
  }

  private entryRemovalInFlight(entry: BindingJournalEntry): boolean {
    return (
      this.inFlight.hasRemoval(entry.platform, entry.target.oldStableId ?? "") ||
      this.inFlight.hasRemoval(journalCreationPlatform(entry), entry.target.newStableId ?? "")
    );
  }

  private attemptAfter(
    entry: Pick<BindingJournalEntry, "attempts">,
    error: string,
    removalInFlight = false,
  ): { error: string; nextAttemptAtMs: number } {
    return {
      error,
      nextAttemptAtMs:
        this.deps.timer.now() +
        (removalInFlight ? 0 : this.backoff.delayForAttempt(entry.attempts + 1)),
    };
  }

  private pendingEntryRemoval(entry: BindingJournalEntry, fromPass = false) {
    const deleting = entry.phase === "deleting";
    const stableId = deleting ? entry.target.oldStableId : entry.target.newStableId;
    return stableId
      ? this.pendingRemoval(
          entry,
          deleting ? entry.platform : journalCreationPlatform(entry),
          stableId,
          fromPass ? "pass" : "caller",
        )
      : undefined;
  }

  private pendingRemoval(
    entry: BindingJournalEntry,
    platform: BindingJournalEntry["platform"],
    stableId: string,
    mode: "caller" | "pass" | "step" = "caller",
  ): Extract<Step, { kind: "blocked" }> | undefined {
    const pending =
      mode === "pass"
        ? this.inFlight.hasRemovalForPass(platform, stableId, this.deps.timer.now())
        : mode === "caller"
          ? this.inFlight.hasRemoval(platform, stableId)
          : this.inFlight.removalBlocked(platform, stableId);
    if (!pending) {
      return undefined;
    }
    // No new attempt/backoff: each finite pass checks once, so this cannot spin. A timeout
    // whose delete still runs stays due in attemptAfter: the first pass after it lands recovers
    // even when the loop's phase and the timeout differ. Settled failures still back off.
    return blocked(entry, "cleanup_pending", `Removal of device '${stableId}' is still in flight.`);
  }
}

/** Why an acquisition waits on an entry another live driver holds. */
function skippedReason(entry: BindingJournalEntry): BindingJournalBlockReason {
  if (entry.kind === "release") {
    return "binding_settling";
  }
  return entry.phase === "deleting" ? "cleanup_pending" : "reconcile_in_progress";
}

function emptyBindingCommit(requestedSpec: unknown): BindingBindingCommit {
  return {
    stableDeviceId: null,
    deviceName: null,
    requestedSpec,
    resolvedSpec: null,
    specFingerprint: null,
    state: "provisioning",
  };
}

function toRecord(
  result: Extract<Step, { kind: "settled" | "blocked" }>,
): BindingJournalRedriveRecord {
  return {
    entryId: result.entry.id,
    kind: result.entry.kind,
    phase: result.entry.phase,
    outcome: result.kind,
    ...(result.kind === "blocked" ? { reason: result.reason } : {}),
  };
}

/**
 * The entry's recorded requested spec, validated; undefined when it no longer parses. A managed
 * binding's requested spec may omit `deviceType` (owner decision Q4), so it is read with the managed
 * schema: reading it as an exact spec would turn an adoptable create into a deletion.
 */
function recordedSpec(entry: BindingJournalEntry): BindingRequestedSpec | undefined {
  const schema =
    journalCreationPlatform(entry) === "android" ? androidBindingSpecSchema : iosBindingSpecSchema;
  const parsed = schema.safeParse(entry.target.requestedSpec);
  return parsed.success ? parsed.data : undefined;
}

/** How often the daemon's owner loop re-runs a redrive pass. */
export const BINDING_JOURNAL_REDRIVE_INTERVAL_MS = 5_000;

/**
 * The durable local owner of journal redrive: one pass at start (daemon startup), then one every
 * interval. Each pass drives every due entry once, so no entry starves and none is abandoned.
 */
export class BindingJournalRedriveLoop {
  private stopped = false;
  private running: Promise<void> | undefined;
  private stopping: Promise<"stopped" | "timed_out"> | undefined;
  private readonly controller = new AbortController();
  private cancelWait: (() => void) | undefined;

  constructor(
    private readonly journal: Pick<BindingJournal, "runPass">,
    private readonly timer: Pick<Timer, "setTimeout" | "clearTimeout">,
    private readonly intervalMs: number = BINDING_JOURNAL_REDRIVE_INTERVAL_MS,
  ) {}

  start(): void {
    if (!this.stopped) {
      this.running ??= this.loop();
    }
  }

  /** Prevent new work, interrupt waits, and join owned work within the shutdown budget. */
  stop(budgetMs: number = BINDING_JOURNAL_STOP_BUDGET_MS): Promise<"stopped" | "timed_out"> {
    this.stopped = true;
    this.controller.abort();
    this.cancelWait?.();
    this.stopping ??= this.join(budgetMs);
    return this.stopping;
  }

  private async join(budgetMs: number): Promise<"stopped" | "timed_out"> {
    try {
      await raceWithDeadline(this.running ?? Promise.resolve(), {
        timer: this.timer,
        timeoutMs: budgetMs,
        label: "journal redrive stop",
      });
      return "stopped";
    } catch (error) {
      logger.warn(`[BindingJournal] redrive stop failed: ${errorMessage(error)}`, error);
      return "timed_out";
    }
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      const handle = this.timer.setTimeout(() => {
        this.cancelWait = undefined;
        resolve();
      }, this.intervalMs);
      this.cancelWait = () => {
        this.timer.clearTimeout(handle);
        this.cancelWait = undefined;
        resolve();
      };
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.journal.runPass({ signal: this.controller.signal });
      } catch (error) {
        // The registry may be briefly unreadable; the next pass retries every open entry.
        logger.warn(`[BindingJournal] redrive pass failed: ${errorMessage(error)}`, error);
      }
      if (this.stopped) {
        return;
      }
      await this.wait();
    }
  }
}
