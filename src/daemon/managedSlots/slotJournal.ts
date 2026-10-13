import type { DeviceInfo } from "../../models";
import {
  androidManagedSlotSpecSchema,
  iosManagedSlotSpecSchema,
} from "../../server/provisionDeviceSpecSchemas";
import {
  exponentialBackoff,
  normalizeBackoff,
  type BackoffInput,
  type BackoffPolicy,
} from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import type {
  ManagedSlotDeletionResult,
  ManagedSlotDeviceClaims,
  ManagedSlotDeviceDeleter,
  ManagedSlotInventory,
  ManagedSlotInventorySnapshot,
  ManagedSlotRequestedSpec,
  ManagedSpecMatcher,
} from "./reconciler";
import { deviceStableId } from "./slotDeviceIdentity";
import { defaultSlotExecOwnerLiveness } from "./slotOwnerLiveness";
import {
  journalOwnersEqual,
  sameBinding,
  type AdvanceSlotJournalInput,
  type SlotAssignmentRecord,
  type SlotBindingCommit,
  type SlotExecOwnerLiveness,
  type SlotJournalEntry,
  type SlotJournalOwner,
  type SlotJournalPhase,
  type SlotKey,
  type SlotRegistry,
  journalCreationPlatform,
} from "./slotRegistry";

/**
 * Journal redrive for managed device slots (#11179, epic #11172).
 *
 * Every create, replace and unsettled release of a slot is recorded in `slot_journal` with the exact
 * devices it acts on, and every phase change shares a transaction with the assignment change it
 * implies. When a process dies mid-work, the entry stays open. A redrive — at daemon startup, at the
 * slot's next acquisition, or from a periodic pass — adopts entries whose owner is dead and drives
 * them to convergence against the recorded targets:
 *
 * - `deleting`: delete and verify absence of the recorded old device, only while the slot still
 *   holds the entry's exact binding; then record the empty slot (`deleted`).
 * - `deleted`: the destructive part is done; the entry commits and the next acquisition creates.
 * - `creating` / `created`: discover the recorded new device by stable id or generated name. An
 *   unheld, matching device is adopted into the slot unless removal was durably requested;
 *   requested removals, mismatching or superseded devices are deleted;
 *   proven absence rolls the entry back.
 * - `release` (`intent`): a drain's `settling` mark. Once its settler is dead and the device is
 *   free of live claims, return the slot to `ready` (or close the entry if the slot already
 *   settled, e.g. through `recoverSettledSlots`).
 *
 * Safety: a device bound to another slot, another generation, or the free pool is never deleted or
 * rewritten; partial inventory or an unreadable configuration is never absence; a failed attempt is
 * recorded with backoff and retried later, never abandoned. Creation is never redriven without a
 * caller: an empty slot is filled by its next acquisition.
 */

/** Delete budget for a redrive step that has no caller deadline. */
export const SLOT_JOURNAL_STEP_BUDGET_MS = 120_000;
export const SLOT_JOURNAL_DISCOVERY_BUDGET_MS = 30_000;
export const SLOT_JOURNAL_CLAIM_BUDGET_MS = 10_000;
export const SLOT_JOURNAL_MATCH_BUDGET_MS = 10_000;
export const SLOT_JOURNAL_DELETE_GRACE_MS = 5_000;
export const SLOT_JOURNAL_STOP_BUDGET_MS = 100;

export interface SlotJournalStageBudgets {
  discoveryMs: number;
  claimMs: number;
  matchMs: number;
  deleteGraceMs: number;
}

interface DriveOptions {
  signal?: AbortSignal;
}

/** Internal unwind: cancellation is not a failed cleanup attempt. */
class SlotJournalDriveCancelled extends Error {
  constructor(readonly reason: unknown) {
    super("Journal drive cancelled");
  }
}

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SlotJournalDriveCancelled(signal.reason);
  }
}
/** Bound on phase transitions one drive performs (each phase moves strictly forward). */
const MAX_STEPS_PER_DRIVE = 6;

export const DEFAULT_SLOT_JOURNAL_BACKOFF = exponentialBackoff({
  initialDelayMs: 1_000,
  multiplier: 2,
  maxDelayMs: 60_000,
});

/** Entries some code in this process is driving right now; a redrive leaves them alone. */
export class SlotJournalInFlight {
  private readonly ids = new Set<number>();
  private readonly removals = new Set<string>();

  hasRemoval(platform: SlotJournalEntry["platform"], stableId: string): boolean {
    return this.removals.has(JSON.stringify([platform, stableId]));
  }

  trackRemoval(
    platform: SlotJournalEntry["platform"],
    stableId: string,
    operation: () => Promise<ManagedSlotDeletionResult>,
  ): Promise<ManagedSlotDeletionResult> {
    const key = JSON.stringify([platform, stableId]);
    this.removals.add(key);
    return Promise.resolve()
      .then(operation)
      .finally(() => this.removals.delete(key));
  }
  add(id: number): void {
    this.ids.add(id);
  }
  delete(id: number): void {
    this.ids.delete(id);
  }
  has(id: number): boolean {
    return this.ids.has(id);
  }
}

export type SlotJournalOwnerLiveness = (owner: SlotJournalOwner) => boolean;

export interface ManagedSlotJournalDependencies {
  registry: SlotRegistry;
  inventory: ManagedSlotInventory;
  matcher: ManagedSpecMatcher;
  deleter: ManagedSlotDeviceDeleter;
  claims: ManagedSlotDeviceClaims;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  stageBudgets?: Partial<SlotJournalStageBudgets>;
  /** This process's identity as a journal owner. */
  owner: SlotJournalOwner;
  /** Whether another owner is still driving its entries; default: its PID is running. */
  isOwnerLive?: SlotJournalOwnerLiveness;
  isExecOwnerLive?: SlotExecOwnerLiveness;
  inFlight?: SlotJournalInFlight;
  backoff?: BackoffInput;
}

export type SlotJournalBlockReason =
  | "discovery_incomplete"
  | "device_busy"
  | "cleanup_pending"
  | "slot_settling"
  | "slot_in_use"
  | "reconcile_in_progress"
  | "scope_not_valid";

export type SlotJournalDriveResult =
  | { kind: "settled"; entry: SlotJournalEntry }
  | {
      kind: "blocked";
      entry: SlotJournalEntry;
      reason: SlotJournalBlockReason;
      message: string;
      retryAfterMs?: number;
    };

/** Summary of one redrive, for acquisition evidence and logs. */
export interface SlotJournalRedriveRecord {
  entryId: number;
  kind: SlotJournalEntry["kind"];
  phase: SlotJournalPhase;
  outcome: "settled" | "blocked";
  reason?: SlotJournalBlockReason;
}

export type SlotRedriveResult =
  | { kind: "clear"; redriven: SlotJournalRedriveRecord[] }
  | {
      kind: "blocked";
      reason: SlotJournalBlockReason;
      message: string;
      entry: SlotJournalEntry;
      redriven: SlotJournalRedriveRecord[];
    };

export interface SlotJournalPassResult {
  settled: SlotJournalRedriveRecord[];
  blocked: SlotJournalRedriveRecord[];
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
      entry: SlotJournalEntry;
      assignment: SlotAssignmentRecord;
      evidence?: unknown;
    }
  | {
      kind: "blocked";
      entry: SlotJournalEntry;
      reason: SlotJournalBlockReason;
      message: string;
      evidence?: unknown;
    };

type Step =
  | { kind: "next"; entry: SlotJournalEntry }
  | { kind: "settled"; entry: SlotJournalEntry }
  | { kind: "blocked"; entry: SlotJournalEntry; reason: SlotJournalBlockReason; message: string };

function blocked(
  entry: SlotJournalEntry,
  reason: SlotJournalBlockReason,
  message: string,
): Extract<Step, { kind: "blocked" }> {
  return { kind: "blocked", entry, reason, message };
}

function keyOf(entry: SlotKey): SlotKey {
  return { scopeKey: entry.scopeKey, slotIndex: entry.slotIndex };
}

export class ManagedSlotJournal {
  readonly inFlight: SlotJournalInFlight;
  private readonly isOwnerLive: SlotJournalOwnerLiveness;
  private readonly isExecOwnerLive: SlotExecOwnerLiveness;
  private readonly backoff: BackoffPolicy;
  private readonly budgets: SlotJournalStageBudgets;

  constructor(private readonly deps: ManagedSlotJournalDependencies) {
    this.inFlight = deps.inFlight ?? new SlotJournalInFlight();
    this.isOwnerLive = deps.isOwnerLive ?? defaultSlotExecOwnerLiveness;
    this.isExecOwnerLive = deps.isExecOwnerLive ?? defaultSlotExecOwnerLiveness;
    this.backoff = normalizeBackoff(deps.backoff ?? DEFAULT_SLOT_JOURNAL_BACKOFF);
    this.budgets = {
      discoveryMs: SLOT_JOURNAL_DISCOVERY_BUDGET_MS,
      claimMs: SLOT_JOURNAL_CLAIM_BUDGET_MS,
      matchMs: SLOT_JOURNAL_MATCH_BUDGET_MS,
      deleteGraceMs: SLOT_JOURNAL_DELETE_GRACE_MS,
      ...deps.stageBudgets,
    };
  }

  get owner(): SlotJournalOwner {
    return this.deps.owner;
  }

  /**
   * Redrive one slot before an acquisition reconciles it. `clear` means no unfinished journaled
   * work remains (the slot may have changed: re-read it); `blocked` names why it cannot proceed.
   */
  async redriveSlot(key: SlotKey, options: DriveOptions = {}): Promise<SlotRedriveResult> {
    try {
      return await this.redriveSlotEntries(key, options.signal);
    } catch (error) {
      if (error instanceof SlotJournalDriveCancelled) {
        // Caller cancellation leaves durable cleanup for its next owner.
        logger.debug("[SlotJournal] acquisition redrive cancelled");
        throw error.reason;
      }
      // Registry failures retain their identity for callers that classify them.
      throw error;
    }
  }

  private async redriveSlotEntries(key: SlotKey, signal?: AbortSignal): Promise<SlotRedriveResult> {
    checkCancellation(signal);
    const redriven: SlotJournalRedriveRecord[] = [];
    let open = await this.deps.registry.listOpenSlotJournal(key);
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
          message: `Slot ${key.slotIndex} has unfinished ${result.entry.kind} work (${result.why}).`,
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
  async runPass(options: DriveOptions = {}): Promise<SlotJournalPassResult> {
    const { signal } = options;
    const pass: SlotJournalPassResult = { settled: [], blocked: [], skipped: 0 };
    if (signal?.aborted) {
      return pass;
    }
    const open = await this.deps.registry.listOpenSlotJournal();
    for (const entry of open) {
      if (signal?.aborted) {
        break;
      }
      try {
        const result = await this.driveEntry(entry, signal);
        if (result.kind === "skipped") {
          pass.skipped += 1;
        } else {
          (result.kind === "settled" ? pass.settled : pass.blocked).push(toRecord(result));
        }
      } catch (error) {
        if (error instanceof SlotJournalDriveCancelled) {
          // Stop is expected; leave the entry open without counting a failed attempt.
          logger.debug("[SlotJournal] pass cancelled");
          break;
        }
        // One entry's failure must not starve the others; it stays open for the next pass.
        logger.warn(
          `[SlotJournal] redrive of entry ${entry.id} failed: ${errorMessage(error)}`,
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
   * Delete and verify absence of a `deleting` entry's old device, then record the empty slot in
   * the same transaction as the `deleted` phase. A failure marks the slot `cleanup_pending` and
   * schedules a retry; the entry stays open.
   */
  async driveDeletion(
    entry: SlotJournalEntry,
    options: DeletionStepOptions = {},
  ): Promise<DeletionStepResult | Extract<Step, { kind: "settled" }>> {
    return this.deletionStep(entry, options);
  }

  private async deletionStep(
    entry: SlotJournalEntry,
    options: DeletionStepOptions,
    signal?: AbortSignal,
  ): Promise<DeletionStepResult | Extract<Step, { kind: "settled" }>> {
    checkCancellation(signal);
    const oldId = entry.target.oldStableId;
    const assignment = await this.deps.registry.getAssignment(keyOf(entry));
    checkCancellation(signal);
    if (!oldId || !assignment || !sameBinding(assignment, entry.binding)) {
      // The slot moved on: its device may now be someone else's, so delete nothing.
      return this.closeStep(entry, "rolled_back", signal);
    }
    if (assignment.execOwner && this.isExecOwnerLive(assignment.execOwner)) {
      return blocked(entry, "slot_in_use", `Slot is held by ${assignment.execOwner.sessionUuid}.`);
    }
    const pending = this.pendingRemoval(entry, entry.platform, oldId);
    if (pending) {
      return pending;
    }
    const located = options.device
      ? { kind: "present" as const, device: options.device }
      : await this.locateForDeletion(entry, oldId, signal);
    if (located.kind === "blocked") {
      return this.recordBlocked(entry, located.reason, located.message, undefined, signal);
    }
    const deletion: ManagedSlotDeletionResult =
      located.kind === "present"
        ? await this.deleteDevice(
            {
              platform: entry.platform,
              stableId: oldId,
              name: entry.target.oldName,
              deadlineMs: options.deadlineMs ?? this.deps.timer.now() + SLOT_JOURNAL_STEP_BUDGET_MS,
              signal: options.signal,
            },
            signal,
          )
        : { kind: "absent", evidence: { listed: false } };
    checkCancellation(signal);
    return this.recordDeletion(entry, oldId, deletion, signal);
  }

  /** Record a deletion outcome: the empty slot with `deleted`, or `cleanup_pending` and a retry. */
  private async recordDeletion(
    entry: SlotJournalEntry,
    oldId: string,
    deletion: ManagedSlotDeletionResult,
    signal?: AbortSignal,
  ): Promise<DeletionStepResult> {
    if (deletion.kind === "failed") {
      const pending = await this.advanceStep(
        entry,
        {
          expectedPhase: "deleting",
          phase: "deleting",
          assignment: { kind: "state", expected: entry.binding, state: "cleanup_pending" },
          attempt: this.attemptAfter(entry, deletion.message),
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
          // A cross-platform replacement moves the emptied slot to the new platform (#11232).
          next: {
            ...emptySlotCommit(entry.target.requestedSpec),
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
   * Settle a `creating`/`created` entry: adopt its recorded device when the slot still holds the
   * entry's binding and the device matches (`adopt`), otherwise remove it. Proven absence rolls the
   * entry back.
   */
  async settleCreation(
    entry: SlotJournalEntry,
    options: { adopt: boolean; deadlineMs?: number } = { adopt: true },
  ): Promise<Step> {
    const pending = entry.target.newStableId
      ? this.pendingRemoval(entry, journalCreationPlatform(entry), entry.target.newStableId)
      : undefined;
    return pending ?? this.creationStep(entry, options);
  }

  private async creationStep(
    entry: SlotJournalEntry,
    options: { adopt: boolean; deadlineMs?: number },
    signal?: AbortSignal,
  ): Promise<Step> {
    checkCancellation(signal);
    const located = await this.locateCreated(entry, signal);
    if (located.kind === "absent") {
      return this.closeStep(entry, "rolled_back", signal);
    }
    if (located.kind === "blocked") {
      return this.recordBlocked(entry, located.reason, located.message, undefined, signal);
    }
    const { device, stableId } = located;
    const locatedPending = this.pendingRemoval(entry, journalCreationPlatform(entry), stableId);
    if (locatedPending) {
      return locatedPending;
    }
    const holder = await this.deps.registry.findDeviceHolder(
      journalCreationPlatform(entry),
      stableId,
    );
    checkCancellation(signal);
    if (holder) {
      // Bound to a slot or parked in the free pool: never ours to adopt or delete.
      return this.closeStep(entry, "rolled_back", signal);
    }
    const assignment = await this.deps.registry.getAssignment(keyOf(entry));
    checkCancellation(signal);
    const current = assignment !== null && sameBinding(assignment, entry.binding);
    const spec = recordedSpec(entry);
    if (options.adopt && !entry.target.removalRequested && current && spec) {
      const match = await this.boundedStage(
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
    entry: SlotJournalEntry,
    phase: "committed" | "rolled_back",
  ): Promise<Extract<Step, { kind: "settled" }>> {
    return this.closeStep(entry, phase);
  }

  private async closeStep(
    entry: SlotJournalEntry,
    phase: "committed" | "rolled_back",
    signal?: AbortSignal,
  ): Promise<Extract<Step, { kind: "settled" }>> {
    const closed = await this.advanceStep(entry, { expectedPhase: entry.phase, phase }, signal);
    return { kind: "settled", entry: closed.kind === "advanced" ? closed.entry : entry };
  }

  async advance(entry: SlotJournalEntry, input: Omit<AdvanceSlotJournalInput, "owner">) {
    return this.advanceStep(entry, input);
  }

  private async advanceStep(
    entry: SlotJournalEntry,
    input: Omit<AdvanceSlotJournalInput, "owner">,
    signal?: AbortSignal,
  ) {
    checkCancellation(signal);
    const result = await this.deps.registry.advanceSlotJournal(entry.id, {
      ...input,
      owner: this.deps.owner,
    });
    checkCancellation(signal);
    return result;
  }

  // --- driving -------------------------------------------------------------------------------

  private async driveEntry(
    initial: SlotJournalEntry,
    signal?: AbortSignal,
  ): Promise<
    | Extract<Step, { kind: "settled" | "blocked" }>
    | { kind: "skipped"; entry: SlotJournalEntry; why: string }
  > {
    checkCancellation(signal);
    if (this.inFlight.has(initial.id)) {
      return { kind: "skipped", entry: initial, why: "in progress in this process" };
    }
    const owned = await this.takeOwnership(initial, signal);
    if (owned.kind === "skipped") {
      return owned;
    }
    let entry = owned.entry;
    const pendingId =
      entry.phase === "deleting" ? entry.target.oldStableId : entry.target.newStableId;
    const pending = pendingId
      ? this.pendingRemoval(
          entry,
          entry.phase === "deleting" ? entry.platform : journalCreationPlatform(entry),
          pendingId,
        )
      : undefined;
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
    entry: SlotJournalEntry,
    signal?: AbortSignal,
  ): Promise<
    | { kind: "owned"; entry: SlotJournalEntry }
    | { kind: "skipped"; entry: SlotJournalEntry; why: string }
  > {
    if (journalOwnersEqual(entry.owner, this.deps.owner)) {
      // Ours but not in flight: the step that opened it aborted. Resume it.
      return { kind: "owned", entry };
    }
    if (this.isOwnerLive(entry.owner)) {
      return { kind: "skipped", entry, why: `owned by live daemon ${entry.owner.daemonId}` };
    }
    const claimed = await this.deps.registry.claimSlotJournal(
      entry.id,
      entry.owner,
      this.deps.owner,
    );
    checkCancellation(signal);
    if (claimed.kind !== "claimed") {
      return { kind: "skipped", entry: claimed.entry ?? entry, why: "claimed by another redrive" };
    }
    logger.info(
      `[SlotJournal] adopted ${entry.kind} entry ${entry.id} (${entry.phase}) of slot ` +
        `${entry.scopeKey.slice(0, 8)}/${entry.slotIndex} from dead owner ${entry.owner.daemonId}`,
    );
    return { kind: "owned", entry: claimed.entry };
  }

  private async step(entry: SlotJournalEntry, signal?: AbortSignal): Promise<Step> {
    if (entry.kind === "release") {
      return this.settleRelease(entry, signal);
    }
    switch (entry.phase) {
      case "deleting": {
        const result = await this.deletionStep(entry, { signal }, signal);
        return result.kind === "deleted" ? { kind: "next", entry: result.entry } : result;
      }
      case "deleted":
        // Destructive work is done; the slot is empty and its next acquisition creates.
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

  private async settleRelease(entry: SlotJournalEntry, signal?: AbortSignal): Promise<Step> {
    const assignment = await this.deps.registry.getAssignment(keyOf(entry));
    checkCancellation(signal);
    if (!assignment || !sameBinding(assignment, entry.binding)) {
      return this.closeStep(entry, "rolled_back", signal);
    }
    if (assignment.state !== "settling") {
      // Already settled (by its watcher, or by `recoverSettledSlots`).
      return this.closeStep(entry, "committed", signal);
    }
    if (assignment.settler && this.isOwnerLive(assignment.settler)) {
      return blocked(entry, "slot_settling", "The slot's settler is still watching its work.");
    }
    if (assignment.execOwner && this.isExecOwnerLive(assignment.execOwner)) {
      return blocked(entry, "slot_in_use", `Slot is held by ${assignment.execOwner.sessionUuid}.`);
    }
    const stableId = assignment.stableDeviceId;
    if (stableId) {
      const free = await this.checkDeviceFree(entry, stableId, signal);
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
        `Restoring the slot failed: ${restored.kind}.`,
      );
    }
    return { kind: "settled", entry: restored.entry };
  }

  /** The released device must be listed and unclaimed, or proven absent, before reuse. */
  private async checkDeviceFree(
    entry: SlotJournalEntry,
    stableId: string,
    signal?: AbortSignal,
  ): Promise<
    { kind: "free" } | { kind: "blocked"; reason: SlotJournalBlockReason; message: string }
  > {
    const inventory = await this.listInventory(entry, entry.platform, signal);
    if (!inventory) {
      return {
        kind: "blocked",
        reason: "discovery_incomplete",
        message: "Device discovery failed.",
      };
    }
    const device = findByStableId(inventory, entry.platform, stableId);
    if (!device) {
      return inventory.complete
        ? { kind: "free" }
        : {
            kind: "blocked",
            reason: "discovery_incomplete",
            message: `Device '${stableId}' was not listed and discovery was incomplete.`,
          };
    }
    const claim = await this.describeClaim(entry, device, signal);
    if (claim.kind === "free") {
      return { kind: "free" };
    }
    return {
      kind: "blocked",
      reason: claim.kind === "held" ? "device_busy" : "discovery_incomplete",
      message: `Device '${stableId}' is not free: ${claim.reason}`,
    };
  }

  // --- deletion ------------------------------------------------------------------------------

  private async locateForDeletion(
    entry: SlotJournalEntry,
    oldId: string,
    signal?: AbortSignal,
  ): Promise<
    | { kind: "present"; device: DeviceInfo }
    | { kind: "absent" }
    | { kind: "blocked"; reason: SlotJournalBlockReason; message: string }
  > {
    const inventory = await this.listInventory(entry, entry.platform, signal);
    if (!inventory) {
      return {
        kind: "blocked",
        reason: "discovery_incomplete",
        message: "Device discovery failed.",
      };
    }
    const device = findByStableId(inventory, entry.platform, oldId);
    if (!device) {
      // Only complete discovery proves absence.
      return inventory.complete
        ? { kind: "absent" }
        : {
            kind: "blocked",
            reason: "discovery_incomplete",
            message: `Device '${oldId}' was not listed and discovery was incomplete.`,
          };
    }
    const claim = await this.describeClaim(entry, device, signal);
    if (claim.kind !== "free") {
      return {
        kind: "blocked",
        reason: claim.kind === "held" ? "device_busy" : "discovery_incomplete",
        message: `Device '${oldId}' cannot be deleted: ${claim.reason}`,
      };
    }
    const holder = await this.deps.registry.findDeviceHolder(entry.platform, oldId);
    checkCancellation(signal);
    if (
      holder?.kind !== "slot" ||
      holder.assignment.scopeKey !== entry.scopeKey ||
      holder.assignment.slotIndex !== entry.slotIndex ||
      !sameBinding(holder.assignment, entry.binding)
    ) {
      return {
        kind: "blocked",
        reason: "reconcile_in_progress",
        message: `Device '${oldId}' is no longer this slot's device.`,
      };
    }
    return { kind: "present", device };
  }

  // --- creation ------------------------------------------------------------------------------

  private async locateCreated(
    entry: SlotJournalEntry,
    signal?: AbortSignal,
  ): Promise<
    | { kind: "present"; device: DeviceInfo; stableId: string }
    | { kind: "absent" }
    | { kind: "blocked"; reason: SlotJournalBlockReason; message: string }
  > {
    const { newStableId, newName } = entry.target;
    if (!newStableId && !newName) {
      return { kind: "absent" };
    }
    const platform = journalCreationPlatform(entry);
    const inventory = await this.listInventory(entry, platform, signal);
    if (!inventory) {
      return {
        kind: "blocked",
        reason: "discovery_incomplete",
        message: "Device discovery failed.",
      };
    }
    const candidates = inventory.devices.filter(
      (device) =>
        device.platform === platform &&
        (newStableId ? deviceStableId(device) === newStableId : device.name === newName),
    );
    if (candidates.length === 0) {
      return inventory.complete
        ? { kind: "absent" }
        : {
            kind: "blocked",
            reason: "discovery_incomplete",
            message: `Created device '${newStableId ?? newName}' was not listed and discovery was incomplete.`,
          };
    }
    const stableId = candidates.length === 1 ? deviceStableId(candidates[0]) : undefined;
    if (!stableId) {
      return {
        kind: "blocked",
        reason: "discovery_incomplete",
        message: `Created device '${newName}' is ambiguous (${candidates.length} listed).`,
      };
    }
    return { kind: "present", device: candidates[0], stableId };
  }

  private async adoptCreated(
    entry: SlotJournalEntry,
    device: DeviceInfo,
    stableId: string,
    signal?: AbortSignal,
  ): Promise<Step> {
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
    // The slot moved on underneath: the device is now an orphan of this entry.
    return this.removeCreated(entry, device, stableId, undefined, signal);
  }

  private async removeCreated(
    entry: SlotJournalEntry,
    device: DeviceInfo,
    stableId: string,
    deadlineMs?: number,
    signal?: AbortSignal,
  ): Promise<Step> {
    if (!entry.target.removalRequested) {
      const recorded = await this.advanceStep(
        entry,
        {
          expectedPhase: entry.phase,
          phase: entry.phase,
          target: { removalRequested: true, newStableId: stableId },
        },
        signal,
      );
      if (recorded.kind !== "advanced") {
        return blocked(
          entry,
          "reconcile_in_progress",
          `Recording removal of '${stableId}' failed: ${recorded.kind}.`,
        );
      }
      entry = recorded.entry;
    }
    const claim = await this.describeClaim(entry, device, signal);
    if (claim.kind !== "free") {
      return this.recordBlocked(
        entry,
        claim.kind === "held" ? "device_busy" : "discovery_incomplete",
        `Uncommitted device '${stableId}' cannot be removed: ${claim.reason}`,
        { newStableId: stableId },
        signal,
      );
    }
    const deletion = await this.deleteDevice(
      {
        platform: journalCreationPlatform(entry),
        stableId,
        name: device.name,
        deadlineMs: deadlineMs ?? this.deps.timer.now() + SLOT_JOURNAL_STEP_BUDGET_MS,
        signal,
      },
      signal,
    );
    if (deletion.kind === "failed") {
      return this.recordBlocked(
        entry,
        "cleanup_pending",
        `Removing uncommitted device '${stableId}' failed: ${deletion.message}`,
        { newStableId: stableId },
        signal,
      );
    }
    const closed = await this.advanceStep(
      entry,
      {
        expectedPhase: entry.phase,
        phase: "rolled_back",
        target: { newStableId: stableId },
      },
      signal,
    );
    return { kind: "settled", entry: closed.kind === "advanced" ? closed.entry : entry };
  }

  // --- legacy rows ---------------------------------------------------------------------------

  /**
   * A slot left `replacing` or `cleanup_pending` (a failed deletion) with no open entry — written
   * before the journal existed — gets a `deleting` entry, so its accepted deletion is redriven like
   * any other. `settling` slots are recovered by their settler rule (`recoverSettledSlots`).
   */
  private async adoptUnjournaledWork(
    key: SlotKey,
    signal?: AbortSignal,
  ): Promise<SlotJournalEntry | null> {
    const assignment = await this.deps.registry.getAssignment(key);
    checkCancellation(signal);
    if (
      !assignment?.stableDeviceId ||
      (assignment.state !== "replacing" && assignment.state !== "cleanup_pending") ||
      (assignment.execOwner && this.isExecOwnerLive(assignment.execOwner))
    ) {
      return null;
    }
    const opened = await this.deps.registry.openSlotJournal(key, {
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
        `[SlotJournal] slot ${key.slotIndex} was left ${assignment.state} without a journal entry; ` +
          `redriving it as entry ${opened.entry.id}`,
      );
      return opened.entry;
    }
    return opened.kind === "journal_open" ? opened.entry : null;
  }

  // --- shared --------------------------------------------------------------------------------

  private async recordBlocked(
    entry: SlotJournalEntry,
    reason: SlotJournalBlockReason,
    message: string,
    target?: Partial<SlotJournalEntry["target"]>,
    signal?: AbortSignal,
  ): Promise<Extract<Step, { kind: "blocked" }>> {
    const phase: SlotJournalPhase =
      target?.newStableId && entry.phase === "creating" ? "created" : entry.phase;
    const recorded = await this.advanceStep(
      entry,
      {
        expectedPhase: entry.phase,
        phase,
        ...(target ? { target } : {}),
        attempt: this.attemptAfter(entry, message),
      },
      signal,
    );
    return blocked(recorded.kind === "advanced" ? recorded.entry : entry, reason, message);
  }

  private attemptAfter(
    entry: SlotJournalEntry,
    error: string,
  ): { error: string; nextAttemptAtMs: number } {
    return {
      error,
      nextAttemptAtMs:
        this.deps.timer.now() +
        (this.inFlight.hasRemoval(entry.platform, entry.target.oldStableId ?? "") ||
        this.inFlight.hasRemoval(journalCreationPlatform(entry), entry.target.newStableId ?? "")
          ? 0
          : this.backoff.delayForAttempt(entry.attempts + 1)),
    };
  }

  private async boundedStage<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    options: { label: string; timeoutMs: number; signal?: AbortSignal; cancel?: AbortSignal },
    failure: (error: unknown) => T,
  ): Promise<T> {
    // Only journal-owned drives unwind; a public step records stage cancellation as failure.
    checkCancellation(options.cancel);
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const timeout = new Error(`${options.label} timed out after ${options.timeoutMs}ms`);
    try {
      const result = await raceWithDeadline(() => operation(signal), {
        timer: this.deps.timer,
        timeoutMs: Math.max(0, options.timeoutMs),
        signal: options.signal,
        label: options.label,
        timeoutError: () => timeout,
        onTimeout: () => controller.abort(timeout),
      });
      checkCancellation(options.cancel);
      return result;
    } catch (error) {
      if (options.cancel?.aborted) {
        controller.abort(options.cancel.reason);
        throw new SlotJournalDriveCancelled(options.cancel.reason);
      }
      // Unreadable discovery and unverified deletion are conservative failures, never absence.
      logger.warn(`[SlotJournal] ${options.label} failed: ${errorMessage(error)}`, error);
      return failure(
        options.signal?.aborted
          ? new Error(`${options.label} cancelled: ${errorMessage(error)}`)
          : error,
      );
    }
  }

  private listInventory(
    entry: SlotJournalEntry,
    platform: SlotJournalEntry["platform"] = entry.platform,
    signal?: AbortSignal,
  ): Promise<ManagedSlotInventorySnapshot | null> {
    return this.boundedStage<ManagedSlotInventorySnapshot | null>(
      (stageSignal) => this.deps.inventory.list(platform, { signal: stageSignal }),
      {
        label: `discovery for entry ${entry.id}`,
        timeoutMs: this.budgets.discoveryMs,
        signal,
        cancel: signal,
      },
      () => null,
    );
  }

  private describeClaim(entry: SlotJournalEntry, device: DeviceInfo, signal?: AbortSignal) {
    return this.boundedStage<Awaited<ReturnType<ManagedSlotDeviceClaims["describe"]>>>(
      () => this.deps.claims.describe(device),
      {
        label: `claim for entry ${entry.id}`,
        timeoutMs: this.budgets.claimMs,
        signal,
        cancel: signal,
      },
      (error) => ({ kind: "unknown", reason: errorMessage(error) }),
    );
  }

  private pendingRemoval(
    entry: SlotJournalEntry,
    platform: SlotJournalEntry["platform"],
    stableId: string,
  ): Extract<Step, { kind: "blocked" }> | undefined {
    if (!this.inFlight.hasRemoval(platform, stableId)) {
      return undefined;
    }
    // No new attempt/backoff: each finite pass checks once, so this cannot spin. A timeout
    // whose delete still runs stays due in attemptAfter: the first pass after it lands recovers
    // even when the loop's phase and the timeout differ. Settled failures still back off.
    return blocked(entry, "cleanup_pending", `Removal of device '${stableId}' is still in flight.`);
  }

  private deleteDevice(
    target: Parameters<ManagedSlotDeviceDeleter["deleteAndVerifyAbsence"]>[0],
    cancel?: AbortSignal,
  ): Promise<ManagedSlotDeletionResult> {
    return this.boundedStage<ManagedSlotDeletionResult>(
      (signal) =>
        this.inFlight.trackRemoval(target.platform, target.stableId, () =>
          this.deps.deleter.deleteAndVerifyAbsence({ ...target, signal }),
        ),
      {
        label: `deleting '${target.stableId}'`,
        timeoutMs: Math.max(
          0,
          target.deadlineMs + this.budgets.deleteGraceMs - this.deps.timer.now(),
        ),
        signal: target.signal,
        cancel,
      },
      (error) => ({ kind: "failed", message: errorMessage(error) }),
    );
  }
}

/** Why an acquisition waits on an entry another live driver holds. */
function skippedReason(entry: SlotJournalEntry): SlotJournalBlockReason {
  if (entry.kind === "release") {
    return "slot_settling";
  }
  return entry.phase === "deleting" ? "cleanup_pending" : "reconcile_in_progress";
}

function findByStableId(
  inventory: ManagedSlotInventorySnapshot,
  platform: SlotJournalEntry["platform"],
  stableId: string,
): DeviceInfo | undefined {
  return inventory.devices.find(
    (device) => device.platform === platform && deviceStableId(device) === stableId,
  );
}

function emptySlotCommit(requestedSpec: unknown): SlotBindingCommit {
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
): SlotJournalRedriveRecord {
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
 * slot's requested spec may omit `deviceType` (owner decision Q4), so it is read with the managed
 * schema: reading it as an exact spec would turn an adoptable create into a deletion.
 */
function recordedSpec(entry: SlotJournalEntry): ManagedSlotRequestedSpec | undefined {
  const schema =
    journalCreationPlatform(entry) === "android"
      ? androidManagedSlotSpecSchema
      : iosManagedSlotSpecSchema;
  const parsed = schema.safeParse(entry.target.requestedSpec);
  return parsed.success ? parsed.data : undefined;
}

/** How often the daemon's owner loop re-runs a redrive pass. */
export const SLOT_JOURNAL_REDRIVE_INTERVAL_MS = 5_000;

/**
 * The durable local owner of journal redrive: one pass at start (daemon startup), then one every
 * interval. Each pass drives every due entry once, so no entry starves and none is abandoned.
 */
export class SlotJournalRedriveLoop {
  private stopped = false;
  private running: Promise<void> | undefined;
  private stopping: Promise<"stopped" | "timed_out"> | undefined;
  private readonly controller = new AbortController();
  private cancelWait: (() => void) | undefined;

  constructor(
    private readonly journal: Pick<ManagedSlotJournal, "runPass">,
    private readonly timer: Pick<Timer, "setTimeout" | "clearTimeout">,
    private readonly intervalMs: number = SLOT_JOURNAL_REDRIVE_INTERVAL_MS,
  ) {}

  start(): void {
    if (!this.stopped) {
      this.running ??= this.loop();
    }
  }

  /** Prevent new work, interrupt waits, and join owned work within the shutdown budget. */
  stop(budgetMs: number = SLOT_JOURNAL_STOP_BUDGET_MS): Promise<"stopped" | "timed_out"> {
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
      logger.warn(`[SlotJournal] redrive stop failed: ${errorMessage(error)}`, error);
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
        logger.warn(`[SlotJournal] redrive pass failed: ${errorMessage(error)}`, error);
      }
      if (this.stopped) {
        return;
      }
      await this.wait();
    }
  }
}
