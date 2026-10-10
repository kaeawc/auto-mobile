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
 *   unheld, matching device is adopted into the slot; a mismatching or superseded one is deleted;
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
  timer: Pick<Timer, "now">;
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

  constructor(private readonly deps: ManagedSlotJournalDependencies) {
    this.inFlight = deps.inFlight ?? new SlotJournalInFlight();
    this.isOwnerLive = deps.isOwnerLive ?? defaultSlotExecOwnerLiveness;
    this.isExecOwnerLive = deps.isExecOwnerLive ?? defaultSlotExecOwnerLiveness;
    this.backoff = normalizeBackoff(deps.backoff ?? DEFAULT_SLOT_JOURNAL_BACKOFF);
  }

  get owner(): SlotJournalOwner {
    return this.deps.owner;
  }

  /**
   * Redrive one slot before an acquisition reconciles it. `clear` means no unfinished journaled
   * work remains (the slot may have changed: re-read it); `blocked` names why it cannot proceed.
   */
  async redriveSlot(key: SlotKey): Promise<SlotRedriveResult> {
    const redriven: SlotJournalRedriveRecord[] = [];
    let open = await this.deps.registry.listOpenSlotJournal(key);
    if (open.length === 0) {
      const synthesized = await this.adoptUnjournaledWork(key);
      open = synthesized ? [synthesized] : [];
    }
    for (const entry of open) {
      const result = await this.driveEntry(entry);
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
  async runPass(): Promise<SlotJournalPassResult> {
    const pass: SlotJournalPassResult = { settled: [], blocked: [], skipped: 0 };
    const open = await this.deps.registry.listOpenSlotJournal();
    for (const entry of open) {
      try {
        const result = await this.driveEntry(entry);
        if (result.kind === "skipped") {
          pass.skipped += 1;
        } else {
          (result.kind === "settled" ? pass.settled : pass.blocked).push(toRecord(result));
        }
      } catch (error) {
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
    const oldId = entry.target.oldStableId;
    const assignment = await this.deps.registry.getAssignment(keyOf(entry));
    if (!oldId || !assignment || !sameBinding(assignment, entry.binding)) {
      // The slot moved on: its device may now be someone else's, so delete nothing.
      return this.close(entry, "rolled_back");
    }
    if (assignment.execOwner && this.isExecOwnerLive(assignment.execOwner)) {
      return blocked(entry, "slot_in_use", `Slot is held by ${assignment.execOwner.sessionUuid}.`);
    }
    const located = options.device
      ? { kind: "present" as const, device: options.device }
      : await this.locateForDeletion(entry, oldId);
    if (located.kind === "blocked") {
      return this.recordBlocked(entry, located.reason, located.message);
    }
    const deletion: ManagedSlotDeletionResult =
      located.kind === "present"
        ? await this.deleteDevice({
            platform: entry.platform,
            stableId: oldId,
            name: entry.target.oldName,
            deadlineMs: options.deadlineMs ?? this.deps.timer.now() + SLOT_JOURNAL_STEP_BUDGET_MS,
            signal: options.signal,
          })
        : { kind: "absent", evidence: { listed: false } };
    return this.recordDeletion(entry, oldId, deletion);
  }

  /** Record a deletion outcome: the empty slot with `deleted`, or `cleanup_pending` and a retry. */
  private async recordDeletion(
    entry: SlotJournalEntry,
    oldId: string,
    deletion: ManagedSlotDeletionResult,
  ): Promise<DeletionStepResult> {
    if (deletion.kind === "failed") {
      const pending = await this.advance(entry, {
        expectedPhase: "deleting",
        phase: "deleting",
        assignment: { kind: "state", expected: entry.binding, state: "cleanup_pending" },
        attempt: this.attemptAfter(entry, deletion.message),
      });
      return {
        kind: "blocked",
        entry: pending.kind === "advanced" ? pending.entry : entry,
        reason: "cleanup_pending",
        message: `Deleting device '${oldId}' failed: ${deletion.message}`,
        evidence: deletion.evidence,
      };
    }
    const emptied = await this.advance(entry, {
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
    });
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
    const located = await this.locateCreated(entry);
    if (located.kind === "absent") {
      return this.close(entry, "rolled_back");
    }
    if (located.kind === "blocked") {
      return this.recordBlocked(entry, located.reason, located.message);
    }
    const { device, stableId } = located;
    const holder = await this.deps.registry.findDeviceHolder(
      journalCreationPlatform(entry),
      stableId,
    );
    if (holder) {
      // Bound to a slot or parked in the free pool: never ours to adopt or delete.
      return this.close(entry, "rolled_back");
    }
    const assignment = await this.deps.registry.getAssignment(keyOf(entry));
    const current = assignment !== null && sameBinding(assignment, entry.binding);
    const spec = recordedSpec(entry);
    if (options.adopt && current && spec) {
      const match = await this.deps.matcher.matches(device, spec);
      if (match === "unknown") {
        return this.recordBlocked(
          entry,
          "discovery_incomplete",
          `Configuration of '${stableId}' is unreadable.`,
        );
      }
      if (match === "match") {
        return this.adoptCreated(entry, device, stableId);
      }
    }
    return this.removeCreated(entry, device, stableId, options.deadlineMs);
  }

  /** Close an entry at a terminal phase (no assignment change). */
  async close(
    entry: SlotJournalEntry,
    phase: "committed" | "rolled_back",
  ): Promise<Extract<Step, { kind: "settled" }>> {
    const closed = await this.advance(entry, { expectedPhase: entry.phase, phase });
    return { kind: "settled", entry: closed.kind === "advanced" ? closed.entry : entry };
  }

  async advance(entry: SlotJournalEntry, input: Omit<AdvanceSlotJournalInput, "owner">) {
    return this.deps.registry.advanceSlotJournal(entry.id, { ...input, owner: this.deps.owner });
  }

  // --- driving -------------------------------------------------------------------------------

  private async driveEntry(
    initial: SlotJournalEntry,
  ): Promise<
    | Extract<Step, { kind: "settled" | "blocked" }>
    | { kind: "skipped"; entry: SlotJournalEntry; why: string }
  > {
    if (this.inFlight.has(initial.id)) {
      return { kind: "skipped", entry: initial, why: "in progress in this process" };
    }
    const owned = await this.takeOwnership(initial);
    if (owned.kind === "skipped") {
      return owned;
    }
    let entry = owned.entry;
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
        const result = await this.step(entry);
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
    if (claimed.kind !== "claimed") {
      return { kind: "skipped", entry: claimed.entry ?? entry, why: "claimed by another redrive" };
    }
    logger.info(
      `[SlotJournal] adopted ${entry.kind} entry ${entry.id} (${entry.phase}) of slot ` +
        `${entry.scopeKey.slice(0, 8)}/${entry.slotIndex} from dead owner ${entry.owner.daemonId}`,
    );
    return { kind: "owned", entry: claimed.entry };
  }

  private async step(entry: SlotJournalEntry): Promise<Step> {
    if (entry.kind === "release") {
      return this.settleRelease(entry);
    }
    switch (entry.phase) {
      case "deleting": {
        const result = await this.driveDeletion(entry);
        return result.kind === "deleted" ? { kind: "next", entry: result.entry } : result;
      }
      case "deleted":
        // Destructive work is done; the slot is empty and its next acquisition creates.
        return this.close(entry, "committed");
      case "intent":
      case "creating":
      case "created":
        return this.settleCreation(entry);
      default:
        return { kind: "settled", entry };
    }
  }

  // --- release -------------------------------------------------------------------------------

  private async settleRelease(entry: SlotJournalEntry): Promise<Step> {
    const assignment = await this.deps.registry.getAssignment(keyOf(entry));
    if (!assignment || !sameBinding(assignment, entry.binding)) {
      return this.close(entry, "rolled_back");
    }
    if (assignment.state !== "settling") {
      // Already settled (by its watcher, or by `recoverSettledSlots`).
      return this.close(entry, "committed");
    }
    if (assignment.settler && this.isOwnerLive(assignment.settler)) {
      return blocked(entry, "slot_settling", "The slot's settler is still watching its work.");
    }
    if (assignment.execOwner && this.isExecOwnerLive(assignment.execOwner)) {
      return blocked(entry, "slot_in_use", `Slot is held by ${assignment.execOwner.sessionUuid}.`);
    }
    const stableId = assignment.stableDeviceId;
    if (stableId) {
      const free = await this.checkDeviceFree(entry, stableId);
      if (free.kind === "blocked") {
        return this.recordBlocked(entry, free.reason, free.message);
      }
    }
    const restored = await this.advance(entry, {
      expectedPhase: entry.phase,
      phase: "committed",
      assignment: { kind: "state", expected: entry.binding, state: "ready" },
    });
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
  ): Promise<
    { kind: "free" } | { kind: "blocked"; reason: SlotJournalBlockReason; message: string }
  > {
    const inventory = await this.listInventory(entry);
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
    const claim = await this.deps.claims.describe(device);
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
  ): Promise<
    | { kind: "present"; device: DeviceInfo }
    | { kind: "absent" }
    | { kind: "blocked"; reason: SlotJournalBlockReason; message: string }
  > {
    const inventory = await this.listInventory(entry);
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
    const claim = await this.deps.claims.describe(device);
    if (claim.kind !== "free") {
      return {
        kind: "blocked",
        reason: claim.kind === "held" ? "device_busy" : "discovery_incomplete",
        message: `Device '${oldId}' cannot be deleted: ${claim.reason}`,
      };
    }
    const holder = await this.deps.registry.findDeviceHolder(entry.platform, oldId);
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
    const inventory = await this.listInventory(entry, platform);
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
  ): Promise<Step> {
    // Readiness is unproven after an interruption: bind as `provisioning`; the acquisition's reuse
    // path re-provisions it to automation readiness before anyone may claim it.
    const adopted = await this.advance(entry, {
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
    });
    if (adopted.kind === "advanced") {
      return { kind: "settled", entry: adopted.entry };
    }
    if (adopted.kind === "journal_conflict") {
      return blocked(entry, "reconcile_in_progress", "The journal entry changed during adoption.");
    }
    // The slot moved on underneath: the device is now an orphan of this entry.
    return this.removeCreated(entry, device, stableId);
  }

  private async removeCreated(
    entry: SlotJournalEntry,
    device: DeviceInfo,
    stableId: string,
    deadlineMs?: number,
  ): Promise<Step> {
    const claim = await this.deps.claims.describe(device);
    if (claim.kind !== "free") {
      return this.recordBlocked(
        entry,
        claim.kind === "held" ? "device_busy" : "discovery_incomplete",
        `Uncommitted device '${stableId}' cannot be removed: ${claim.reason}`,
        { newStableId: stableId },
      );
    }
    const deletion = await this.deleteDevice({
      platform: journalCreationPlatform(entry),
      stableId,
      name: device.name,
      deadlineMs: deadlineMs ?? this.deps.timer.now() + SLOT_JOURNAL_STEP_BUDGET_MS,
    });
    if (deletion.kind === "failed") {
      return this.recordBlocked(
        entry,
        "cleanup_pending",
        `Removing uncommitted device '${stableId}' failed: ${deletion.message}`,
        { newStableId: stableId },
      );
    }
    const closed = await this.advance(entry, {
      expectedPhase: entry.phase,
      phase: "rolled_back",
      target: { newStableId: stableId },
    });
    return { kind: "settled", entry: closed.kind === "advanced" ? closed.entry : entry };
  }

  // --- legacy rows ---------------------------------------------------------------------------

  /**
   * A slot left `replacing` or `cleanup_pending` (a failed deletion) with no open entry — written
   * before the journal existed — gets a `deleting` entry, so its accepted deletion is redriven like
   * any other. `settling` slots are recovered by their settler rule (`recoverSettledSlots`).
   */
  private async adoptUnjournaledWork(key: SlotKey): Promise<SlotJournalEntry | null> {
    const assignment = await this.deps.registry.getAssignment(key);
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
  ): Promise<Extract<Step, { kind: "blocked" }>> {
    const phase: SlotJournalPhase =
      target?.newStableId && entry.phase === "creating" ? "created" : entry.phase;
    const recorded = await this.advance(entry, {
      expectedPhase: entry.phase,
      phase,
      ...(target ? { target } : {}),
      attempt: this.attemptAfter(entry, message),
    });
    return blocked(recorded.kind === "advanced" ? recorded.entry : entry, reason, message);
  }

  private attemptAfter(
    entry: SlotJournalEntry,
    error: string,
  ): { error: string; nextAttemptAtMs: number } {
    return {
      error,
      nextAttemptAtMs: this.deps.timer.now() + this.backoff.delayForAttempt(entry.attempts + 1),
    };
  }

  private async listInventory(
    entry: SlotJournalEntry,
    platform: SlotJournalEntry["platform"] = entry.platform,
  ): Promise<ManagedSlotInventorySnapshot | null> {
    try {
      return await this.deps.inventory.list(platform, {});
    } catch (error) {
      logger.warn(
        `[SlotJournal] device discovery for entry ${entry.id} failed: ${errorMessage(error)}`,
        error,
      );
      return null;
    }
  }

  private async deleteDevice(
    target: Parameters<ManagedSlotDeviceDeleter["deleteAndVerifyAbsence"]>[0],
  ): Promise<ManagedSlotDeletionResult> {
    try {
      return await this.deps.deleter.deleteAndVerifyAbsence(target);
    } catch (error) {
      // An unverified deletion is a failed deletion: the device may still exist.
      logger.warn(
        `[SlotJournal] deleting '${target.stableId}' threw: ${errorMessage(error)}`,
        error,
      );
      return { kind: "failed", message: errorMessage(error) };
    }
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

  constructor(
    private readonly journal: Pick<ManagedSlotJournal, "runPass">,
    private readonly timer: Pick<Timer, "sleep">,
    private readonly intervalMs: number = SLOT_JOURNAL_REDRIVE_INTERVAL_MS,
  ) {}

  start(): void {
    this.running ??= this.loop();
  }

  /** Stop after the current pass; resolves once the loop has exited. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.journal.runPass();
      } catch (error) {
        // The registry may be briefly unreadable; the next pass retries every open entry.
        logger.warn(`[SlotJournal] redrive pass failed: ${errorMessage(error)}`, error);
      }
      if (this.stopped) {
        return;
      }
      await this.timer.sleep(this.intervalMs);
    }
  }
}
