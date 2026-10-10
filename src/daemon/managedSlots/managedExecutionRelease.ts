/**
 * End-of-execution drain for managed device slots (epic #11172, #11177).
 *
 * Releasing a managed execution ends its live control of the slot's device and nothing more: the
 * slot keeps its device (`slot → device` assignment, generation and spec untouched), and the device
 * never becomes generically allocatable, because generic exclusion reads the assignment, not the
 * execution owner. Only the slot's `exec_*` owner columns are cleared.
 *
 * The drain cancels the session's in-flight work, waits a bounded budget for it to end, releases
 * the session (bounded too; a wedged release is forced into the existing stuck-release quarantine),
 * and acknowledges one of two outcomes:
 *
 * - `reusable_for_this_slot`: every owned action and the release's restoration settled, so the
 *   slot's next acquisition may take the device at once.
 * - `cleanup_pending`: some work outlived the budget. The slot is marked `settling` (fenced: the
 *   generation advances) BEFORE its execution owner is cleared, so there is no instant at which it
 *   looks ready and unowned; `claimExecution` refuses a non-ready slot, so the next acquisition
 *   waits. This daemon is recorded as the slot's settler. Its watcher returns the slot to `ready`
 *   once the work settles; past the watcher's cap, or after this daemon exits, the slot stays
 *   `settling` until {@link SlotRegistry.recoverSettledSlots} finds its settler dead (the work died
 *   with it) — a restarted daemon runs that recovery when it opens the registry. A failed device
 *   deletion is a different state (`cleanup_pending`) that only the journal redrive resolves.
 *
 * The same slot bookkeeping runs for a managed session released any other way (heartbeat loss, idle
 * window, forced stuck release): the assignment is always kept.
 */

import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../managedExecutionLiveness";
import {
  forceStuckSessionRelease,
  releaseSessionAndDevice,
  type SessionReleasePool,
} from "../releaseSessionAndDevice";
import { currentSlotOwnerProcess } from "./slotOwnerLiveness";
import type { SlotJournalInFlight } from "./slotJournal";
import type {
  SlotAssignmentRecord,
  SlotAssignmentState,
  SlotKey,
  SlotPlatform,
  SlotProcessIdentity,
  SlotRegistry,
} from "./slotRegistry";

export type ManagedExecutionReleaseOutcome = "reusable_for_this_slot" | "cleanup_pending";

/**
 * `confirmed`: nothing the execution started is still running. `settling`: cancellation was
 * requested but some work (an action, or the release's restoration) has not ended yet.
 */
export type ManagedExecutionSettlement = "confirmed" | "settling";

/** One slot the released execution held, as it stands after the release. */
export interface ManagedExecutionSlotEvidence {
  scopeKey: string;
  slotIndex: number;
  role: string;
  platform: SlotPlatform;
  generation: number;
  stableDeviceId: string | null;
  deviceName: string | null;
  state: SlotAssignmentState;
  /** True when this release cleared the slot's execution owner (false when already cleared). */
  execOwnerReleased: boolean;
}

export interface ManagedExecutionSlotFailure {
  scopeKey: string;
  slotIndex: number;
  error: string;
}

export interface ManagedExecutionReleaseResult {
  sessionId: string;
  outcome: ManagedExecutionReleaseOutcome;
  settlement: ManagedExecutionSettlement;
  /** The session was no longer live when this release arrived (a repeated or late release). */
  alreadyReleased: boolean;
  /** How many in-flight executions this release asked to cancel. */
  cancellationRequested: number;
  /** The session's release outlived its budget and was forced into the stuck-release quarantine. */
  releaseForced: boolean;
  /** The device the session held, when known. Still assigned to its slot. */
  device: string | null;
  slots: ManagedExecutionSlotEvidence[];
  /** Per-slot bookkeeping that failed; every other slot was still released. */
  slotFailures: ManagedExecutionSlotFailure[];
}

/** The registry slice the drain needs. */
export type ManagedExecutionSlotRegistry = Pick<
  SlotRegistry,
  | "findExecutionAssignments"
  | "releaseExecution"
  | "updateSlotState"
  | "getAssignment"
  | "recoverSettledSlots"
  | "openSlotJournal"
  | "advanceSlotJournal"
>;

/**
 * Journal the drain's `settling` marks (#11179): each mark opens a `release` entry owned by this
 * daemon (the settler) in the same transaction, closed when the slot returns to `ready`. A daemon
 * that dies before its work settles leaves the entry for a later daemon's redrive.
 */
export interface ManagedExecutionReleaseJournal {
  /** Entries this drain is still guarding; a redrive in this process leaves them alone. */
  inFlight: SlotJournalInFlight;
}

/** The execution-tracker slice the drain needs (cancel, bounded wait, and a settled probe). */
export interface ManagedExecutionWork {
  cancelDeviceSessionExecutions(sessionId: string, reason: string): Promise<number>;
  waitForDeviceSessionExecutionsToEnd(sessionId: string, timeoutMs: number): Promise<boolean>;
  hasActiveDeviceSessionExecutions(sessionId: string): boolean;
}

/** The session-manager and pool slice the drain needs. */
export interface ManagedExecutionSessions {
  /** Live or mid-release in this daemon. */
  isSessionLive(sessionId: string): boolean;
  /** The device the session holds (or held, while its release is fenced), if known. */
  deviceOf(sessionId: string): string | null;
  /** Release the session and hand its device back to the pool; resolves to the released device. */
  releaseSession(sessionId: string): Promise<string | null>;
  /** Force a release stuck past its budget into the bounded quarantine; true when one was forced. */
  forceStuckRelease(sessionId: string): Promise<boolean>;
  /** The device's release teardown or quarantine has not settled yet. */
  hasDeviceCleanupInProgress(deviceId: string): boolean;
}

/** The release-callback snapshot fields the listener reads. */
export interface ManagedExecutionReleaseNotice {
  sessionId: string;
  deviceId: string;
  livenessPolicy?: string;
}

/**
 * The daemon side of `daemon/releaseExecution` stays inside the proxy's 1.5 s call timeout
 * (`MANAGED_EXECUTION_RELEASE_TIMEOUT_MS`): drain + release budgets plus registry writes.
 */
export const MANAGED_EXECUTION_DRAIN_BUDGET_MS = 500;
export const MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS = 700;
/** How often the settlement watcher re-checks unsettled work. */
export const MANAGED_EXECUTION_SETTLEMENT_POLL_MS = 250;
/**
 * How long the watcher waits for unsettled work before leaving the slot `settling` for later
 * recovery (once this daemon exits, its slots are recoverable). Generous: a stuck action blocks
 * only its own slot.
 */
export const MANAGED_EXECUTION_SETTLEMENT_CAP_MS = 5 * 60 * 1000;
/** Released sessions remembered so a repeated release can still name its slots. */
const RECENT_RELEASE_LIMIT = 256;

const RELEASE_REASON = "managed-execution-release";

export interface ManagedExecutionReleaseOptions {
  registry: () => Promise<ManagedExecutionSlotRegistry>;
  work: ManagedExecutionWork;
  sessions: ManagedExecutionSessions;
  timer: Timer;
  drainBudgetMs?: number;
  releaseBudgetMs?: number;
  settlementPollMs?: number;
  settlementCapMs?: number;
  /** This daemon, recorded as the settler of slots it marks `settling`. Default: this process. */
  settler?: SlotProcessIdentity;
  journal?: ManagedExecutionReleaseJournal;
}

interface MarkedSlot {
  key: SlotKey;
  generation: number;
  stableDeviceId: string | null;
  /** The release journal entry recording the mark, when journaling is on. */
  journalEntryId?: number;
}

export class ManagedExecutionRelease {
  private readonly drainBudgetMs: number;
  private readonly releaseBudgetMs: number;
  private readonly settlementPollMs: number;
  private readonly settlementCapMs: number;
  /** Releases this coordinator is driving; the release listener leaves them to it. */
  private readonly driven = new Map<string, Promise<ManagedExecutionReleaseResult>>();
  private readonly recentSlots = new Map<string, SlotKey[]>();
  private readonly background = new Set<Promise<void>>();
  private closed = false;
  private settler: SlotProcessIdentity | undefined;

  constructor(private readonly options: ManagedExecutionReleaseOptions) {
    this.drainBudgetMs = options.drainBudgetMs ?? MANAGED_EXECUTION_DRAIN_BUDGET_MS;
    this.releaseBudgetMs = options.releaseBudgetMs ?? MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS;
    this.settlementPollMs = options.settlementPollMs ?? MANAGED_EXECUTION_SETTLEMENT_POLL_MS;
    this.settlementCapMs = options.settlementCapMs ?? MANAGED_EXECUTION_SETTLEMENT_CAP_MS;
  }

  /**
   * Drain and release one execution's session (`daemon/releaseExecution`). Concurrent calls for
   * the same session share one drain; a later call reports the current state (idempotent).
   */
  releaseExecution(sessionId: string): Promise<ManagedExecutionReleaseResult> {
    const inFlight = this.driven.get(sessionId);
    if (inFlight) {
      return inFlight;
    }
    const drain = this.drainAndRelease(sessionId).finally(() => {
      this.driven.delete(sessionId);
    });
    this.driven.set(sessionId, drain);
    return drain;
  }

  /**
   * Session-release listener: a managed session released by anything but this coordinator
   * (heartbeat loss, idle window, forced stuck release) gives up its slots' execution ownership the
   * same way, keeping every assignment.
   */
  onSessionReleased(
    notice: ManagedExecutionReleaseNotice,
    options?: { upgradeOnly?: boolean },
  ): void {
    if (
      options?.upgradeOnly ||
      notice.livenessPolicy !== MANAGED_EXECUTION_LIVENESS_POLICY ||
      this.driven.has(notice.sessionId) ||
      this.closed
    ) {
      return;
    }
    this.track(this.releaseSlotsAfterExternalRelease(notice.sessionId, notice.deviceId));
  }

  /** Resolves once every background slot release and settlement watcher has finished. */
  async whenIdle(): Promise<void> {
    while (this.background.size > 0) {
      await Promise.allSettled([...this.background]);
    }
  }

  /**
   * Restart-time recovery: return every `settling` slot whose settler is dead to `ready`. Resolves
   * to the recovered slots; a failure is logged and recovers nothing.
   */
  async recoverSettledSlots(): Promise<SlotAssignmentRecord[]> {
    try {
      const recovered = await (await this.options.registry()).recoverSettledSlots();
      if (recovered.length > 0) {
        logger.info(
          `[ManagedExecutionRelease] Recovered ${recovered.length} settled slot(s) whose settling ` +
            "daemon is gone",
        );
      }
      return recovered;
    } catch (error) {
      logger.warn(
        `[ManagedExecutionRelease] Recovering settled slots failed: ${errorMessage(error)}`,
        error,
      );
      return [];
    }
  }

  /** Stop the settlement watchers (daemon shutdown). Slots they guard stay `settling`. */
  close(): void {
    this.closed = true;
  }

  private async drainAndRelease(sessionId: string): Promise<ManagedExecutionReleaseResult> {
    const { sessions } = this.options;
    const registry = await this.options.registry();
    const held = await registry.findExecutionAssignments(sessionId);
    const live = sessions.isSessionLive(sessionId);
    if (held.length === 0 && !live) {
      return this.reportReleased(registry, sessionId);
    }
    this.rememberSlots(sessionId, held);
    const device = sessions.deviceOf(sessionId);

    const { cancellationRequested, drained } = await this.cancelAndDrain(sessionId);
    const slotFailures: ManagedExecutionSlotFailure[] = [];
    const marked: MarkedSlot[] = [];
    if (!drained) {
      // Protect the slots before anything else lets go: unsettled work may still drive the device.
      marked.push(...(await this.markSettling(registry, held, slotFailures)));
    }

    const release = live
      ? await this.releaseSessionWithinBudget(sessionId, device)
      : { releasedDevice: device, releaseSettled: true, releaseForced: false };
    const { releasedDevice, releaseForced } = release;

    // A slot marked before the release stays reported pending; its watcher confirms settlement.
    const settled = drained && release.releaseSettled && this.isSettled(sessionId, releasedDevice);
    if (!settled && drained) {
      marked.push(...(await this.markSettling(registry, held, slotFailures)));
    }
    const slots = await this.releaseOwnership(registry, sessionId, held, slotFailures);
    if (marked.length > 0) {
      this.track(this.settleLater(registry, sessionId, releasedDevice, marked));
    }
    return {
      sessionId,
      outcome: settled ? "reusable_for_this_slot" : "cleanup_pending",
      settlement: settled ? "confirmed" : "settling",
      alreadyReleased: !live,
      cancellationRequested,
      releaseForced,
      device: releasedDevice,
      slots,
      slotFailures,
    };
  }

  /** Cancel the session's in-flight work and wait for it to end within the drain budget. */
  private async cancelAndDrain(
    sessionId: string,
  ): Promise<{ cancellationRequested: number; drained: boolean }> {
    const { work } = this.options;
    const cancellationRequested = await work.cancelDeviceSessionExecutions(
      sessionId,
      RELEASE_REASON,
    );
    if (cancellationRequested === 0 && !work.hasActiveDeviceSessionExecutions(sessionId)) {
      return { cancellationRequested, drained: true };
    }
    const drained = await work.waitForDeviceSessionExecutionsToEnd(sessionId, this.drainBudgetMs);
    return { cancellationRequested, drained };
  }

  /** A session already gone: report its slots (if remembered) and any work it left behind. */
  private async reportReleased(
    registry: ManagedExecutionSlotRegistry,
    sessionId: string,
  ): Promise<ManagedExecutionReleaseResult> {
    const keys = this.recentSlots.get(sessionId) ?? [];
    const assignments = (await Promise.all(keys.map((key) => registry.getAssignment(key)))).filter(
      (assignment): assignment is SlotAssignmentRecord => assignment !== null,
    );
    const stillSettling =
      this.options.work.hasActiveDeviceSessionExecutions(sessionId) ||
      assignments.some((assignment) => assignment.state === "settling");
    return {
      sessionId,
      outcome: stillSettling ? "cleanup_pending" : "reusable_for_this_slot",
      settlement: stillSettling ? "settling" : "confirmed",
      alreadyReleased: true,
      cancellationRequested: 0,
      releaseForced: false,
      device: null,
      slots: assignments.map((assignment) => toEvidence(assignment, false)),
      slotFailures: [],
    };
  }

  private async releaseSessionWithinBudget(
    sessionId: string,
    device: string | null,
  ): Promise<{ releasedDevice: string | null; releaseSettled: boolean; releaseForced: boolean }> {
    const { sessions, timer } = this.options;
    const release = sessions.releaseSession(sessionId);
    try {
      const releasedDevice = await raceWithDeadline(release, {
        timer,
        timeoutMs: this.releaseBudgetMs,
        unref: true,
        label: `Managed execution release of session ${sessionId}`,
      });
      return {
        releasedDevice: releasedDevice ?? device,
        releaseSettled: true,
        releaseForced: false,
      };
    } catch (error) {
      logger.warn(
        `[ManagedExecutionRelease] Session ${sessionId} release did not finish within ` +
          `${this.releaseBudgetMs}ms; forcing it into the stuck-release quarantine: ` +
          errorMessage(error),
        error,
      );
    }
    let releaseForced = false;
    try {
      releaseForced = await sessions.forceStuckRelease(sessionId);
    } catch (error) {
      logger.warn(
        `[ManagedExecutionRelease] Forcing the stuck release of ${sessionId} failed: ` +
          errorMessage(error),
        error,
      );
    }
    // Forced or merely slow, the release's restoration is not confirmed settled.
    return { releasedDevice: device, releaseSettled: false, releaseForced };
  }

  private isSettled(sessionId: string, deviceId: string | null): boolean {
    return (
      !this.options.work.hasActiveDeviceSessionExecutions(sessionId) &&
      (deviceId === null || !this.options.sessions.hasDeviceCleanupInProgress(deviceId))
    );
  }

  private async releaseSlotsAfterExternalRelease(
    sessionId: string,
    deviceId: string,
  ): Promise<void> {
    const registry = await this.options.registry();
    const held = await registry.findExecutionAssignments(sessionId);
    if (held.length === 0) {
      return;
    }
    this.rememberSlots(sessionId, held);
    const slotFailures: ManagedExecutionSlotFailure[] = [];
    const marked = this.isSettled(sessionId, deviceId)
      ? []
      : await this.markSettling(registry, held, slotFailures);
    await this.releaseOwnership(registry, sessionId, held, slotFailures);
    for (const failure of slotFailures) {
      logger.warn(
        `[ManagedExecutionRelease] Slot ${failure.scopeKey}/${failure.slotIndex} bookkeeping ` +
          `after the release of ${sessionId} failed: ${failure.error}`,
      );
    }
    if (marked.length > 0) {
      await this.settleLater(registry, sessionId, deviceId, marked);
    }
  }

  /** Mark each held slot `settling` (with this daemon as settler) under its current binding. */
  private async markSettling(
    registry: ManagedExecutionSlotRegistry,
    held: readonly SlotAssignmentRecord[],
    failures: ManagedExecutionSlotFailure[],
  ): Promise<MarkedSlot[]> {
    const results = await Promise.allSettled(
      held.map(async (assignment): Promise<MarkedSlot | null> => {
        const key = slotKeyOf(assignment);
        const binding = {
          generation: assignment.generation,
          stableDeviceId: assignment.stableDeviceId,
        };
        const journaled = await this.markJournaled(registry, assignment, failures);
        if (journaled !== "unjournaled") {
          return journaled;
        }
        const updated = await registry.updateSlotState(key, binding, "settling", {
          settler: this.settlerIdentity(),
        });
        if (updated.kind !== "updated") {
          failures.push({ ...key, error: `could not mark settling: ${updated.kind}` });
          return null;
        }
        // Entering the fence bumped the generation; the watcher restores under the new one.
        return {
          key,
          generation: updated.assignment.generation,
          stableDeviceId: updated.assignment.stableDeviceId,
        };
      }),
    );
    return results.flatMap((result, index) => {
      if (result.status === "rejected") {
        failures.push({ ...slotKeyOf(held[index]), error: errorMessage(result.reason) });
        return [];
      }
      return result.value ? [result.value] : [];
    });
  }

  /**
   * Mark one slot `settling` through a release journal entry, in one transaction. Returns
   * `unjournaled` when journaling is off or the slot already has an open entry (which governs it),
   * so the caller marks the slot directly.
   */
  private async markJournaled(
    registry: ManagedExecutionSlotRegistry,
    assignment: SlotAssignmentRecord,
    failures: ManagedExecutionSlotFailure[],
  ): Promise<MarkedSlot | null | "unjournaled"> {
    const journal = this.options.journal;
    if (!journal) {
      return "unjournaled";
    }
    const key = slotKeyOf(assignment);
    const settler = this.settlerIdentity();
    const opened = await registry.openSlotJournal(key, {
      kind: "release",
      phase: "intent",
      owner: settler,
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
        state: "settling",
        options: { settler },
      },
    });
    if (opened.kind === "opened") {
      journal.inFlight.add(opened.entry.id);
      // Entering the fence bumped the generation; the watcher restores under the new one.
      return {
        key,
        generation: opened.assignment.generation,
        stableDeviceId: opened.assignment.stableDeviceId,
        journalEntryId: opened.entry.id,
      };
    }
    if (opened.kind === "journal_open") {
      return "unjournaled";
    }
    failures.push({ ...key, error: `could not mark settling: ${opened.kind}` });
    return null;
  }

  /** Clear this session's execution ownership of every held slot; one failure never stops the rest. */
  private async releaseOwnership(
    registry: ManagedExecutionSlotRegistry,
    sessionId: string,
    held: readonly SlotAssignmentRecord[],
    failures: ManagedExecutionSlotFailure[],
  ): Promise<ManagedExecutionSlotEvidence[]> {
    const results = await Promise.allSettled(
      held.map((assignment) => registry.releaseExecution(slotKeyOf(assignment), sessionId)),
    );
    return results.flatMap((result, index) => {
      if (result.status === "rejected") {
        failures.push({ ...slotKeyOf(held[index]), error: errorMessage(result.reason) });
        return [toEvidence(held[index], false)];
      }
      const current = result.value.assignment ?? held[index];
      return [toEvidence(current, result.value.released)];
    });
  }

  /**
   * Return each marked slot to `ready` once the session's work and the device's teardown settle.
   * Only a slot still at the marked binding, still `settling` and unowned is touched, so a
   * newer binding or execution is never disturbed.
   */
  private async settleLater(
    registry: ManagedExecutionSlotRegistry,
    sessionId: string,
    deviceId: string | null,
    marked: readonly MarkedSlot[],
  ): Promise<void> {
    const { timer } = this.options;
    const deadline = timer.now() + this.settlementCapMs;
    while (!this.isSettled(sessionId, deviceId)) {
      if (this.closed) {
        return;
      }
      if (timer.now() >= deadline) {
        logger.warn(
          `[ManagedExecutionRelease] Work of released session ${sessionId} did not settle within ` +
            `${this.settlementCapMs}ms; its slots stay settling until this daemon's exit makes ` +
            "them recoverable",
        );
        // Their release journal entries stay in flight here: the work may still be running in this
        // process, so only a later daemon (once this one is gone) redrives them.
        return;
      }
      await timer.sleep(this.settlementPollMs);
    }
    await Promise.all(marked.map((slot) => this.restoreReady(registry, slot)));
  }

  private async restoreReady(
    registry: ManagedExecutionSlotRegistry,
    slot: MarkedSlot,
  ): Promise<void> {
    try {
      const current = await registry.getAssignment(slot.key);
      if (
        !current ||
        current.state !== "settling" ||
        current.generation !== slot.generation ||
        current.stableDeviceId !== slot.stableDeviceId ||
        current.execOwner !== null
      ) {
        await this.closeSupersededEntry(registry, slot, current);
        return;
      }
      const updated = await this.restoreSlotState(registry, slot);
      if (updated.kind !== "updated" && updated.kind !== "advanced") {
        logger.warn(
          `[ManagedExecutionRelease] Slot ${slot.key.scopeKey}/${slot.key.slotIndex} settled but ` +
            `could not return to ready: ${updated.kind}`,
        );
      }
    } catch (error) {
      logger.warn(
        `[ManagedExecutionRelease] Returning slot ${slot.key.scopeKey}/${slot.key.slotIndex} to ` +
          `ready failed; it stays settling: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /** Return a settled slot to `ready`, closing its release journal entry in the same transaction. */
  private async restoreSlotState(registry: ManagedExecutionSlotRegistry, slot: MarkedSlot) {
    const binding = { generation: slot.generation, stableDeviceId: slot.stableDeviceId };
    const journal = this.options.journal;
    if (!journal || slot.journalEntryId === undefined) {
      return registry.updateSlotState(slot.key, binding, "ready");
    }
    try {
      return await registry.advanceSlotJournal(slot.journalEntryId, {
        owner: this.settlerIdentity(),
        expectedPhase: "intent",
        phase: "committed",
        assignment: { kind: "state", expected: binding, state: "ready" },
      });
    } finally {
      journal.inFlight.delete(slot.journalEntryId);
    }
  }

  /**
   * The slot moved on before settlement: close its release entry (rolled back when the binding
   * changed, committed when something else already restored it). A slot that gained an execution
   * owner meanwhile keeps its entry open for redrive.
   */
  private async closeSupersededEntry(
    registry: ManagedExecutionSlotRegistry,
    slot: MarkedSlot,
    current: SlotAssignmentRecord | null,
  ): Promise<void> {
    const journal = this.options.journal;
    if (!journal || slot.journalEntryId === undefined || current?.execOwner) {
      return;
    }
    const rebound =
      !current ||
      current.generation !== slot.generation ||
      current.stableDeviceId !== slot.stableDeviceId;
    try {
      await registry.advanceSlotJournal(slot.journalEntryId, {
        owner: this.settlerIdentity(),
        expectedPhase: "intent",
        phase: rebound ? "rolled_back" : "committed",
      });
    } finally {
      journal.inFlight.delete(slot.journalEntryId);
    }
  }

  private settlerIdentity(): SlotProcessIdentity {
    this.settler ??= this.options.settler ?? {
      daemonId: `pid-${process.pid}`,
      ...currentSlotOwnerProcess(),
    };
    return this.settler;
  }

  private rememberSlots(sessionId: string, held: readonly SlotAssignmentRecord[]): void {
    if (held.length === 0) {
      return;
    }
    this.recentSlots.delete(sessionId);
    this.recentSlots.set(sessionId, held.map(slotKeyOf));
    if (this.recentSlots.size > RECENT_RELEASE_LIMIT) {
      const oldest = this.recentSlots.keys().next().value;
      if (oldest !== undefined) {
        this.recentSlots.delete(oldest);
      }
    }
  }

  private track(task: Promise<void>): void {
    const tracked = task
      .catch((error: unknown) => {
        logger.warn(
          `[ManagedExecutionRelease] Background slot release failed: ${errorMessage(error)}`,
          error,
        );
      })
      .finally(() => {
        this.background.delete(tracked);
      });
    this.background.add(tracked);
  }
}

function slotKeyOf(assignment: SlotKey): SlotKey {
  return { scopeKey: assignment.scopeKey, slotIndex: assignment.slotIndex };
}

function toEvidence(
  assignment: SlotAssignmentRecord,
  execOwnerReleased: boolean,
): ManagedExecutionSlotEvidence {
  return {
    scopeKey: assignment.scopeKey,
    slotIndex: assignment.slotIndex,
    role: assignment.role,
    platform: assignment.platform,
    generation: assignment.generation,
    stableDeviceId: assignment.stableDeviceId,
    deviceName: assignment.deviceName,
    state: assignment.state,
    execOwnerReleased,
  };
}

/** The session-manager surface {@link managedExecutionSessionsFrom} adapts. */
export interface ManagedExecutionSessionManager {
  hasSession(sessionId: string): boolean;
  getSession(sessionId: string): { assignedDevice: string } | null;
  getReleasingSession(sessionId: string): { assignedDevice: string } | null;
  getTerminalReleaseSnapshot(sessionId: string): { deviceId: string } | undefined;
  releaseSession(sessionId: string, reason?: string): Promise<string | null>;
  forceStuckRelease(sessionId: string): { deviceId: string } | undefined;
  hasDeviceCleanupInProgress(deviceId: string): boolean;
}

/**
 * The daemon's sessions as the drain sees them: release goes through the same
 * {@link releaseSessionAndDevice} path as `daemon/releaseSession` (the device returns to the pool,
 * where generic exclusion still keeps it to its slot), and a stuck release through
 * {@link forceStuckSessionRelease}.
 */
export function managedExecutionSessionsFrom(
  manager: ManagedExecutionSessionManager,
  pool: SessionReleasePool,
): ManagedExecutionSessions {
  const deviceOf = (sessionId: string): string | null =>
    manager.getSession(sessionId)?.assignedDevice ??
    manager.getReleasingSession(sessionId)?.assignedDevice ??
    manager.getTerminalReleaseSnapshot(sessionId)?.deviceId ??
    null;
  return {
    isSessionLive: (sessionId) =>
      manager.hasSession(sessionId) || manager.getReleasingSession(sessionId) !== null,
    deviceOf,
    releaseSession: async (sessionId) => {
      let deviceId = deviceOf(sessionId);
      await releaseSessionAndDevice(manager, pool, deviceId, sessionId, undefined, {
        release: async () => {
          deviceId = await manager.releaseSession(sessionId);
          return deviceId;
        },
      });
      return deviceId;
    },
    forceStuckRelease: async (sessionId) => {
      let forced = false;
      await forceStuckSessionRelease(
        {
          forceStuckRelease: (id) => {
            const result = manager.forceStuckRelease(id);
            forced = result !== undefined;
            return result;
          },
        },
        pool,
        sessionId,
      );
      return forced;
    },
    hasDeviceCleanupInProgress: (deviceId) => manager.hasDeviceCleanupInProgress(deviceId),
  };
}
