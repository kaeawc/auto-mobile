import type { SessionReleaseReason } from "../releaseReasons";
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
 *   once the work settles, however long that takes (past the cap it re-checks at a slower
 *   cadence, #11336); after this daemon exits, the slot stays `settling` until
 *   {@link SlotRegistry.recoverSettledSlots} finds its settler dead (the work died with it) — a
 *   restarted daemon runs that recovery when it opens the registry. A failed device
 *   deletion is a different state (`cleanup_pending`) that only the journal redrive resolves.
 *
 * The host-wide registry is shared by several daemons and reports contention as a thrown busy
 * error, so no registry step of the drain is taken on faith (#11616). A step that throws is either
 * retried with the injected backoff (up to the settlement cap, then at the slow re-check cadence
 * until it lands or this daemon closes) or fails closed: the step after it never runs as if it had
 * succeeded. In particular a `settling` mark that could not be written keeps the slot's owner
 * record, and this daemon keeps reading that record as live ({@link ManagedExecutionOwnerHolds})
 * for as long as the released work runs, so the slot is never claimable under it.
 *
 * What says "released work is still running" is in the registry, where every daemon reads it, and
 * always names this daemon's process: the `settling` mark (this daemon as settler), or, until the
 * mark lands, the owner record. A record that still names another process (the previous daemon
 * after a restart not re-owned yet, or a second daemon) is re-stamped with this daemon before the
 * slot is marked, the same write a restart's re-own makes (`ManagedExecutionReowner`). Either one
 * reads live for as long as this process runs and dead once it is gone, when its work is gone
 * too: nothing outlives the process and nothing needs an operator. The in-memory hold only covers
 * this process's own view of its own record, which it never judges by PID (#11339), and is kept,
 * not dropped, when the daemon closes with the work still running.
 *
 * The same slot bookkeeping runs for a managed session released any other way (heartbeat loss, idle
 * window, forced stuck release): the assignment is always kept.
 */

import { type BackoffPolicy, exponentialBackoff } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { DefaultRetryExecutor, type RetryExecutor } from "../../utils/retry/RetryExecutor";
import type { Timer } from "../../utils/SystemTimer";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../managedExecutionLiveness";
import {
  forceStuckSessionRelease,
  releaseSessionAndDevice,
  type SessionReleasePool,
} from "../releaseSessionAndDevice";
import {
  currentSlotOwnerProcess,
  defaultSlotExecOwnerLiveness,
  inFlightSlotReservations,
} from "./slotOwnerLiveness";
import type { SlotJournalInFlight } from "./slotJournal";
import { journalOwnersEqual } from "./slotRegistry";
import type {
  SlotAssignmentRecord,
  SlotAssignmentState,
  SlotExecOwner,
  SlotExecOwnerLiveness,
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
  | "claimExecution"
  | "releaseExecution"
  | "updateSlotState"
  | "getAssignment"
  | "recoverSettledSlots"
  | "openSlotJournal"
  | "advanceSlotJournal"
  | "listOpenSlotJournal"
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
 * How long the watcher polls unsettled work at the fast cadence. Past it the slot stays `settling`
 * and the watcher keeps going at {@link MANAGED_EXECUTION_SETTLEMENT_SLOW_POLL_MS}, so the slot
 * returns to `ready` whenever its work finally settles (#11336).
 */
export const MANAGED_EXECUTION_SETTLEMENT_CAP_MS = 5 * 60 * 1000;
/** How often the watcher re-checks work that outlived the cap. */
export const MANAGED_EXECUTION_SETTLEMENT_SLOW_POLL_MS = 30 * 1000;
/**
 * How a registry step of the drain that threw (a busy host-wide registry) is retried until the
 * settlement cap; past the cap it is re-tried every {@link MANAGED_EXECUTION_SETTLEMENT_SLOW_POLL_MS}.
 */
export const MANAGED_EXECUTION_REGISTRY_RETRY_BACKOFF: BackoffPolicy = exponentialBackoff({
  initialDelayMs: 250,
  maxDelayMs: 5_000,
});
/** Released sessions remembered so a repeated release can still name its slots. */
const RECENT_RELEASE_LIMIT = 256;

const RELEASE_REASON = "managed-execution-release";

/**
 * Session ids whose owner records this daemon must keep reading as live although the session is
 * gone: the released work still runs and its slot's `settling` mark has not been written yet
 * (#11616). The daemon's owner liveness (`withLiveExecutionSessions`) reads the same set as its
 * in-flight reservations, so the registry refuses a claim of such a slot.
 */
export interface ManagedExecutionOwnerHolds {
  add(sessionId: string): void;
  delete(sessionId: string): void;
}

export interface ManagedExecutionReleaseOptions {
  registry: () => Promise<ManagedExecutionSlotRegistry>;
  work: ManagedExecutionWork;
  sessions: ManagedExecutionSessions;
  timer: Timer;
  drainBudgetMs?: number;
  releaseBudgetMs?: number;
  settlementPollMs?: number;
  settlementCapMs?: number;
  settlementSlowPollMs?: number;
  /** This daemon, recorded as the settler of slots it marks `settling`. Default: this process. */
  settler?: SlotProcessIdentity;
  journal?: ManagedExecutionReleaseJournal;
  /**
   * Judges an owner record left on a slot this drain marked `settling` (#11545): pass the
   * registry's own predicate, so the watcher and the registry agree. Default: PID plus process
   * start identity, under which a record this daemon wrote always reads live and is never cleared.
   */
  isExecOwnerLive?: SlotExecOwnerLiveness;
  /** Backoff between retries of a registry step that threw. Default: 250 ms doubling to 5 s. */
  registryRetryBackoff?: BackoffPolicy;
  /**
   * Where the drain records the released sessions whose owner records must still read live.
   * Default: the process-wide set the daemon's owner liveness reads.
   */
  ownerHolds?: ManagedExecutionOwnerHolds;
}

interface MarkedSlot {
  key: SlotKey;
  generation: number;
  stableDeviceId: string | null;
  /** The release journal entry recording the mark, when journaling is on. */
  journalEntryId?: number;
}

/** The `settling` marks of one release: the slots fenced, and the ones whose mark threw (owed). */
interface SettlingMarks {
  marked: MarkedSlot[];
  owed: SlotAssignmentRecord[];
  /** Slots whose owner record names this daemon, or needs no re-stamp. */
  stamped: Set<SlotAssignmentRecord>;
  /** A failed re-stamp was already reported for this release. */
  stampWarned: boolean;
}

function newSettlingMarks(): SettlingMarks {
  return { marked: [], owed: [], stamped: new Set(), stampWarned: false };
}

/** What a mark attempt came to when it did not throw: fenced, refused, or not journaled. */
type MarkAttempt = MarkedSlot | { refused: string };

export class ManagedExecutionRelease {
  private readonly drainBudgetMs: number;
  private readonly releaseBudgetMs: number;
  private readonly settlementPollMs: number;
  private readonly settlementCapMs: number;
  private readonly settlementSlowPollMs: number;
  /** Releases this coordinator is driving; the release listener leaves them to it. */
  private readonly driven = new Map<string, Promise<ManagedExecutionReleaseResult>>();
  private readonly recentSlots = new Map<string, SlotKey[]>();
  private readonly background = new Set<Promise<void>>();
  private closed = false;
  /** Aborted on close: ends a retry's wait at once and stops it before its next registry call. */
  private readonly closing = new AbortController();
  private settler: SlotProcessIdentity | undefined;
  private readonly isExecOwnerLive: SlotExecOwnerLiveness;
  private readonly registryRetryBackoff: BackoffPolicy;
  private readonly registryRetry: RetryExecutor;
  private readonly ownerHolds: ManagedExecutionOwnerHolds;
  /** Holders per session id, so one drain's release never drops another's hold. */
  private readonly ownerHoldCounts = new Map<string, number>();
  /** Failed owner clears being retried, one per slot and session ({@link retryOwnerClear}). */
  private readonly ownerClearRetries = new Set<string>();

  constructor(private readonly options: ManagedExecutionReleaseOptions) {
    this.isExecOwnerLive = options.isExecOwnerLive ?? defaultSlotExecOwnerLiveness;
    this.drainBudgetMs = options.drainBudgetMs ?? MANAGED_EXECUTION_DRAIN_BUDGET_MS;
    this.releaseBudgetMs = options.releaseBudgetMs ?? MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS;
    this.settlementPollMs = options.settlementPollMs ?? MANAGED_EXECUTION_SETTLEMENT_POLL_MS;
    this.settlementCapMs = options.settlementCapMs ?? MANAGED_EXECUTION_SETTLEMENT_CAP_MS;
    this.settlementSlowPollMs =
      options.settlementSlowPollMs ?? MANAGED_EXECUTION_SETTLEMENT_SLOW_POLL_MS;
    this.registryRetryBackoff =
      options.registryRetryBackoff ?? MANAGED_EXECUTION_REGISTRY_RETRY_BACKOFF;
    this.registryRetry = new DefaultRetryExecutor(options.timer);
    this.ownerHolds = options.ownerHolds ?? inFlightSlotReservations;
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
      this.warn(
        `[ManagedExecutionRelease] Recovering settled slots failed: ${errorMessage(error)}`,
        error,
      );
      return [];
    }
  }

  /**
   * Stop the settlement watchers and every pending registry retry (daemon shutdown): no registry
   * step is started after this, and nothing is logged. Slots they guard stay `settling`, for the
   * next daemon's recovery. A slot whose mark is still owed keeps its owner record, and the hold
   * on it is kept while its work runs: this process may outlive the close, and a daemon started
   * meanwhile reads the record (it names this process) as live until this process is gone.
   */
  close(): void {
    this.closed = true;
    this.closing.abort();
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
    // Until this drain has fenced or settled its slots, the owner record reads live even after
    // the session is gone: a mark that throws must not leave the slot claimable (#11616).
    const releaseHold = this.holdOwner(sessionId, device);
    try {
      return await this.drainHeldSlots(registry, sessionId, held, live, device);
    } finally {
      releaseHold();
    }
  }

  private async drainHeldSlots(
    registry: ManagedExecutionSlotRegistry,
    sessionId: string,
    held: readonly SlotAssignmentRecord[],
    live: boolean,
    device: string | null,
  ): Promise<ManagedExecutionReleaseResult> {
    const { cancellationRequested, drained } = await this.cancelAndDrain(sessionId);
    const slotFailures: ManagedExecutionSlotFailure[] = [];
    const marks = newSettlingMarks();
    if (!drained) {
      // Protect the slots before anything else lets go: unsettled work may still drive the device.
      await this.markSettling(registry, sessionId, held, slotFailures, marks);
    }

    const release = live
      ? await this.releaseSessionWithinBudget(sessionId, device)
      : { releasedDevice: device, releaseSettled: true, releaseForced: false };
    const { releasedDevice, releaseForced } = release;

    // A slot marked before the release stays reported pending; its watcher confirms settlement.
    const settled = drained && release.releaseSettled && this.isSettled(sessionId, releasedDevice);
    if (!settled && drained) {
      await this.markSettling(registry, sessionId, held, slotFailures, marks);
    }
    const slots = await this.releaseOwnership(registry, sessionId, held, slotFailures, marks.owed);
    if (marks.marked.length > 0) {
      this.track(this.settleLater(registry, sessionId, releasedDevice, marks.marked));
    }
    if (marks.owed.length > 0) {
      const releaseOwedHold = this.holdOwner(sessionId, releasedDevice);
      this.track(this.settleOwedMarks(registry, sessionId, releasedDevice, marks, releaseOwedHold));
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
      this.warn(
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
      this.warn(
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
    // The session is already gone, so only this hold keeps its slots from being claimed while
    // its work still runs and the registry cannot be read or marked yet (#11616).
    const releaseHold = this.holdOwner(sessionId, deviceId);
    try {
      // A lookup that throws is retried until it lands, also once the work has settled: the
      // owner record it would leave may name another running daemon (a restart not re-owned yet,
      // or a second daemon), which this daemon reads as live for as long as that process runs.
      // Only a record this daemon wrote is dead by its ended session (#11339), and which one it
      // is cannot be known without the lookup. Settled work needs no hold meanwhile.
      const found = await this.retryRegistryStep(
        `Finding the slots of released session ${sessionId}`,
        this.options.timer.now() + this.settlementCapMs,
        async () => {
          if (this.isSettled(sessionId, deviceId)) {
            releaseHold();
          }
          const registry = await this.options.registry();
          return { registry, held: await registry.findExecutionAssignments(sessionId) };
        },
      );
      if (!found.done || found.value.held.length === 0) {
        return;
      }
      const { registry, held } = found.value;
      this.rememberSlots(sessionId, held);
      const slotFailures: ManagedExecutionSlotFailure[] = [];
      const marks = newSettlingMarks();
      if (!this.isSettled(sessionId, deviceId)) {
        await this.markSettling(registry, sessionId, held, slotFailures, marks);
      }
      await this.releaseOwnership(registry, sessionId, held, slotFailures, marks.owed);
      for (const failure of slotFailures) {
        this.warn(
          `[ManagedExecutionRelease] Slot ${failure.scopeKey}/${failure.slotIndex} bookkeeping ` +
            `after the release of ${sessionId} failed: ${failure.error}`,
        );
      }
      const owedHold = marks.owed.length > 0 ? this.holdOwner(sessionId, deviceId) : undefined;
      // Every slot is fenced or has its own hold now. The watcher must read a leftover owner
      // record as what it is (dead), or it would wait out the cap on this very hold.
      releaseHold();
      await Promise.all([
        marks.marked.length > 0
          ? this.settleLater(registry, sessionId, deviceId, marks.marked)
          : undefined,
        owedHold ? this.settleOwedMarks(registry, sessionId, deviceId, marks, owedHold) : undefined,
      ]);
    } finally {
      releaseHold();
    }
  }

  /**
   * Mark each held slot `settling` (with this daemon as settler) under its current binding, adding
   * to `marks`. A mark that throws is owed: its slot keeps its owner record, which
   * {@link settleOwedMarks} fences or clears later. The record is made this daemon's first
   * ({@link stampOwners}), so an owed mark leaves a slot that every daemon reads as in use.
   */
  private async markSettling(
    registry: ManagedExecutionSlotRegistry,
    sessionId: string,
    held: readonly SlotAssignmentRecord[],
    failures: ManagedExecutionSlotFailure[],
    marks: SettlingMarks,
  ): Promise<void> {
    await this.stampOwners(registry, sessionId, held, marks);
    const results = await Promise.allSettled(
      held.map((assignment) => this.markSlot(registry, assignment, failures)),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        failures.push({
          ...slotKeyOf(held[index]),
          error:
            `could not mark settling: ${errorMessage(result.reason)}; the slot keeps its ` +
            "owner record and the mark is retried",
        });
        marks.owed.push(held[index]);
      } else if (result.value) {
        marks.marked.push(result.value);
      }
    });
  }

  /**
   * Re-stamp, with this daemon, every owner record of `sessionId` that names another process: the
   * previous daemon (a restart whose re-own has not happened or failed) or a second one. The
   * record is what holds a slot whose `settling` mark is owed, and other daemons judge it by the
   * process it names: a dead previous daemon's record reads dead to all of them, and a record
   * naming a daemon that never held this session reads dead to that daemon. Named after this
   * process it reads live everywhere while this process runs, and dead (recoverable by the usual
   * liveness rule) once it is gone.
   *
   * Never throws. A re-stamp that fails is retried with the owed mark; until one of the two lands
   * only this process's own hold stands, since nothing could be written.
   */
  private async stampOwners(
    registry: ManagedExecutionSlotRegistry,
    sessionId: string,
    held: readonly SlotAssignmentRecord[],
    marks: SettlingMarks,
  ): Promise<void> {
    const self = this.settlerIdentity();
    const results = await Promise.allSettled(
      held.map(async (assignment) => {
        const owner = assignment.execOwner;
        if (
          marks.stamped.has(assignment) ||
          owner === null ||
          owner.sessionUuid !== sessionId ||
          journalOwnersEqual(owner, self)
        ) {
          return;
        }
        // Refused (the slot is not `ready` at this binding any more): it is not claimable as it
        // stands, and the mark that follows reports what became of it.
        await registry.claimExecution(
          slotKeyOf(assignment),
          { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
          { ...self, sessionUuid: sessionId },
          { supersedesSessionUuid: sessionId },
        );
      }),
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        marks.stamped.add(held[index]);
      } else if (!marks.stampWarned) {
        marks.stampWarned = true;
        const key = slotKeyOf(held[index]);
        this.warn(
          `[ManagedExecutionRelease] Slot ${key.scopeKey}/${key.slotIndex} of released session ` +
            `${sessionId} still names another daemon as its owner and could not be re-stamped; ` +
            `it is retried with the settling mark: ${errorMessage(result.reason)}`,
          result.reason,
        );
      }
    });
  }

  /**
   * Mark one slot `settling`. Resolves to the fence, or to null when the registry refused the
   * mark (the slot moved on; reported in `failures`). Throws when the mark is still owed.
   *
   * The mark is idempotent across attempts. A registry call can reject after its transaction
   * committed, so a throw is followed by a re-read: a slot that is durably `settling` under this
   * daemon at the binding this mark enters is marked, and gets its watcher like any other. The
   * same re-read follows a refusal, which is what a retry of such a mark comes to once the first
   * attempt's re-read failed too (the fence already moved the generation on).
   */
  private async markSlot(
    registry: ManagedExecutionSlotRegistry,
    assignment: SlotAssignmentRecord,
    failures: ManagedExecutionSlotFailure[],
  ): Promise<MarkedSlot | null> {
    let attempt: MarkAttempt;
    try {
      attempt = await this.markSlotOnce(registry, assignment);
    } catch (error) {
      const landed = await this.findOwnMark(registry, assignment);
      if (landed === null) {
        throw error;
      }
      const key = slotKeyOf(assignment);
      this.warn(
        `[ManagedExecutionRelease] Marking slot ${key.scopeKey}/${key.slotIndex} settling failed ` +
          `after the mark was written; going on from the written mark: ${errorMessage(error)}`,
        error,
      );
      return landed;
    }
    if (!("refused" in attempt)) {
      return attempt;
    }
    const landed = await this.findOwnMark(registry, assignment);
    if (landed === null) {
      failures.push({
        ...slotKeyOf(assignment),
        error: `could not mark settling: ${attempt.refused}`,
      });
    }
    return landed;
  }

  /** One attempt at the mark: through a release journal entry, else directly. */
  private async markSlotOnce(
    registry: ManagedExecutionSlotRegistry,
    assignment: SlotAssignmentRecord,
  ): Promise<MarkAttempt> {
    const journaled = await this.markJournaled(registry, assignment);
    if (journaled !== "unjournaled") {
      return journaled;
    }
    const key = slotKeyOf(assignment);
    const updated = await registry.updateSlotState(
      key,
      { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
      "settling",
      { settler: this.settlerIdentity() },
    );
    if (updated.kind !== "updated") {
      return { refused: updated.kind };
    }
    // Entering the fence bumped the generation; the watcher restores under the new one.
    return {
      key,
      generation: updated.assignment.generation,
      stableDeviceId: updated.assignment.stableDeviceId,
    };
  }

  /**
   * This drain's own `settling` mark of `assignment`, read back from the registry: the slot is
   * `settling` under this daemon, on the same device, one generation past the binding the mark
   * was made from (entering the fence advances it by one). A `settling` slot accepts no claim and
   * no other fence, so nothing else produces that state from that binding. Null when the mark is
   * not there. May throw (registry).
   */
  private async findOwnMark(
    registry: ManagedExecutionSlotRegistry,
    assignment: SlotAssignmentRecord,
  ): Promise<MarkedSlot | null> {
    const key = slotKeyOf(assignment);
    const self = this.settlerIdentity();
    const current = await registry.getAssignment(key);
    if (
      current === null ||
      current.state !== "settling" ||
      current.settler === null ||
      !journalOwnersEqual(current.settler, self) ||
      current.stableDeviceId !== assignment.stableDeviceId ||
      current.generation !== assignment.generation + 1
    ) {
      return null;
    }
    const marked: MarkedSlot = {
      key,
      generation: current.generation,
      stableDeviceId: current.stableDeviceId,
    };
    const journal = this.options.journal;
    if (!journal) {
      return marked;
    }
    const entry = (await registry.listOpenSlotJournal(key)).find(
      (open) => open.kind === "release" && journalOwnersEqual(open.owner, self),
    );
    if (!entry) {
      return marked;
    }
    journal.inFlight.add(entry.id);
    return { ...marked, journalEntryId: entry.id };
  }

  /**
   * Finish the slots whose `settling` mark threw (#11616). Their owner records were kept and read
   * live under `releaseHold`, so none was claimable meanwhile. The mark is retried until it lands
   * or the released work settles (nothing is left to fence); only then is ownership cleared and
   * the hold released. A slot marked late gets the usual settlement watcher.
   */
  private async settleOwedMarks(
    registry: ManagedExecutionSlotRegistry,
    sessionId: string,
    deviceId: string | null,
    first: SettlingMarks,
    releaseHold: () => void,
  ): Promise<void> {
    const owed: readonly SlotAssignmentRecord[] = [...first.owed];
    const marks: SettlingMarks = { ...first, marked: [], owed: [...owed] };
    const settled = (): boolean => this.isSettled(sessionId, deviceId);
    try {
      await this.retryRegistryStep(
        `Marking the slots of released session ${sessionId} settling`,
        this.options.timer.now() + this.settlementCapMs,
        async () => {
          if (settled()) {
            return;
          }
          const failures: ManagedExecutionSlotFailure[] = [];
          const retried = marks.owed;
          marks.owed = [];
          await this.markSettling(registry, sessionId, retried, failures, marks);
          if (marks.owed.length > 0) {
            throw new Error(failures.map((failure) => failure.error).join("; "));
          }
          for (const failure of failures) {
            this.warn(
              `[ManagedExecutionRelease] Slot ${failure.scopeKey}/${failure.slotIndex} of ` +
                `released session ${sessionId}: ${failure.error}`,
            );
          }
        },
        settled,
      );
      if (this.closed) {
        // The records stay, and so does the hold while the work runs (see holdOwner); they die
        // with this process, and so does any work still running.
        return;
      }
      // Every owed slot is now fenced `settling`, or its work has settled: let go of the owner.
      const failures: ManagedExecutionSlotFailure[] = [];
      await this.releaseOwnership(registry, sessionId, owed, failures, []);
      for (const failure of failures) {
        this.warn(
          `[ManagedExecutionRelease] Clearing the owner of slot ${failure.scopeKey}/` +
            `${failure.slotIndex} for released session ${sessionId} failed; the dead record ` +
            `pins nothing in this daemon (#11339) and the clear is retried: ${failure.error}`,
        );
      }
    } finally {
      releaseHold();
    }
    if (marks.marked.length > 0) {
      await this.settleLater(registry, sessionId, deviceId, marks.marked);
    }
  }

  /**
   * Mark one slot `settling` through a release journal entry, in one transaction. Returns
   * `unjournaled` when journaling is off or the slot already has an open entry (which governs it),
   * so the caller marks the slot directly.
   */
  private async markJournaled(
    registry: ManagedExecutionSlotRegistry,
    assignment: SlotAssignmentRecord,
  ): Promise<MarkAttempt | "unjournaled"> {
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
    return { refused: opened.kind };
  }

  /**
   * Clear this session's execution ownership of every held slot; one failure never stops the
   * rest. A slot whose `settling` mark is owed keeps its owner (reported as not released): the
   * fence comes first. A clear that throws leaves a record that is dead by liveness once the
   * drain's hold ends, which pins nothing in this daemon (#11339). It still names this running
   * process, which every other daemon on the host reads as live, so the clear is retried until it
   * lands ({@link retryOwnerClear}, #11545).
   */
  private async releaseOwnership(
    registry: ManagedExecutionSlotRegistry,
    sessionId: string,
    held: readonly SlotAssignmentRecord[],
    failures: ManagedExecutionSlotFailure[],
    owed: readonly SlotAssignmentRecord[],
  ): Promise<ManagedExecutionSlotEvidence[]> {
    const results = await Promise.allSettled(
      held.map(async (assignment) =>
        owed.includes(assignment)
          ? { released: false, assignment }
          : registry.releaseExecution(slotKeyOf(assignment), sessionId),
      ),
    );
    return results.flatMap((result, index) => {
      if (result.status === "rejected") {
        failures.push({ ...slotKeyOf(held[index]), error: errorMessage(result.reason) });
        this.track(this.retryOwnerClear(registry, slotKeyOf(held[index]), sessionId));
        return [toEvidence(held[index], false)];
      }
      const current = result.value.assignment ?? held[index];
      return [toEvidence(current, result.value.released)];
    });
  }

  /**
   * Return each marked slot to `ready` once the session's work and the device's teardown settle.
   * Only a slot still at the marked binding, still `settling` and without a live owner is
   * touched, so a newer binding or execution is never disturbed. A slot whose owner record is
   * live at that moment is re-checked until the owner goes or the settlement cap passes (#11545).
   */
  private async settleLater(
    registry: ManagedExecutionSlotRegistry,
    sessionId: string,
    deviceId: string | null,
    marked: readonly MarkedSlot[],
  ): Promise<void> {
    const { timer } = this.options;
    const deadline = timer.now() + this.settlementCapMs;
    let pastCap = false;
    while (!this.isSettled(sessionId, deviceId)) {
      if (this.closed) {
        return;
      }
      if (!pastCap && timer.now() >= deadline) {
        pastCap = true;
        this.warn(
          `[ManagedExecutionRelease] Work of released session ${sessionId} did not settle within ` +
            `${this.settlementCapMs}ms; its slots stay settling and are re-checked every ` +
            `${this.settlementSlowPollMs}ms until the work settles (#11336)`,
        );
      }
      // The release journal entries stay in flight meanwhile: the work may still be running in
      // this process, so this watcher alone settles them once it ends.
      await timer.sleep(pastCap ? this.settlementSlowPollMs : this.settlementPollMs);
    }
    await this.restoreOnceUnowned(registry, marked, deadline);
  }

  /**
   * Restore every settled slot, re-checking the ones a live owner record still holds (#11545).
   * The record is the released session's own (see {@link clearLeftoverOwner}); when this daemon
   * holds that session id again it reads live, and the slot can only return to `ready` after that
   * session ends. A one-shot check would leave it `settling` for the daemon's lifetime, so the
   * check repeats at the fast cadence. It is bounded by the same cap as the release itself: past
   * it the slot stays `settling`, where `reset-slot-scope --force` applies once the owner is gone.
   * Each slot is re-checked on its own, so one whose registry step keeps failing (and is retried
   * past the cap) never holds up another's re-check (#11616).
   */
  private async restoreOnceUnowned(
    registry: ManagedExecutionSlotRegistry,
    marked: readonly MarkedSlot[],
    deadline: number,
  ): Promise<void> {
    const stillOwned = (
      await Promise.all(marked.map((slot) => this.restoreSlotOnceUnowned(registry, slot, deadline)))
    ).filter((slot): slot is MarkedSlot => slot !== null);
    if (stillOwned.length === 0) {
      return;
    }
    const slots = stillOwned.map((slot) => `${slot.key.scopeKey}/${slot.key.slotIndex}`).join(", ");
    this.warn(
      `[ManagedExecutionRelease] A live execution still holds the owner record of settled ` +
        `slot(s) ${slots} past the ${this.settlementCapMs}ms settlement cap; they stay ` +
        "settling. Once that execution ends, `reset-slot-scope --force` or a daemon restart " +
        "returns them to ready (#11545)",
    );
  }

  /** Resolves to the slot when a live owner record still held it at the cap, else to null. */
  private async restoreSlotOnceUnowned(
    registry: ManagedExecutionSlotRegistry,
    slot: MarkedSlot,
    deadline: number,
  ): Promise<MarkedSlot | null> {
    const { timer } = this.options;
    for (;;) {
      const outcome = await this.restoreReady(registry, slot, deadline);
      if (outcome === "done" || this.closed) {
        return null;
      }
      if (timer.now() >= deadline) {
        return slot;
      }
      await timer.sleep(this.settlementPollMs);
    }
  }

  /**
   * Resolves to `owner_live` when a live owner record kept the slot `settling`: check again. A
   * registry read or write that throws is retried, never taken as done (#11616): the released
   * work has settled, so nothing else returns this slot to `ready` while this daemon lives (the
   * redrive leaves a live settler's entry alone and `--force` refuses inside the cap).
   */
  private async restoreReady(
    registry: ManagedExecutionSlotRegistry,
    slot: MarkedSlot,
    deadline: number,
  ): Promise<"done" | "owner_live"> {
    const restored = await this.retryRegistryStep(
      `Returning settled slot ${slot.key.scopeKey}/${slot.key.slotIndex} to ready`,
      deadline,
      () => this.restoreReadyOnce(registry, slot),
    );
    // Not done only when this daemon is closing: the slot stays `settling` for the next daemon.
    return restored.done ? restored.value : "done";
  }

  /** One attempt at {@link restoreReady}; throws when the registry does. */
  private async restoreReadyOnce(
    registry: ManagedExecutionSlotRegistry,
    slot: MarkedSlot,
  ): Promise<"done" | "owner_live"> {
    const current = await registry.getAssignment(slot.key);
    const atMark =
      current !== null &&
      current.state === "settling" &&
      current.generation === slot.generation &&
      current.stableDeviceId === slot.stableDeviceId;
    if (!atMark) {
      await this.closeSupersededEntry(registry, slot, current);
      return "done";
    }
    if (!(await this.clearLeftoverOwner(registry, slot, current.execOwner))) {
      // Still this watcher's to settle: the entry stays open and guarded in flight.
      return "owner_live";
    }
    const updated = await this.restoreSlotState(registry, slot);
    if (updated.kind !== "updated" && updated.kind !== "advanced") {
      this.warn(
        `[ManagedExecutionRelease] Slot ${slot.key.scopeKey}/${slot.key.slotIndex} settled but ` +
          `could not return to ready: ${updated.kind}`,
      );
    }
    return "done";
  }

  /**
   * Run one registry step of the drain, retrying while it throws (#11616). Retries follow the
   * injected backoff until `deadline` (the settlement cap) and the slow re-check cadence after
   * it, so a busy registry is never hammered and the step still lands whenever the registry
   * recovers. It stops, without a further registry call, when this daemon closes or when
   * `stopWhen` says the step is no longer needed; `done: false` then tells the caller the step
   * did NOT happen, so it must not go on as if it had.
   */
  private async retryRegistryStep<T>(
    what: string,
    deadline: number,
    step: () => Promise<T>,
    stopWhen?: () => boolean,
  ): Promise<{ done: true; value: T } | { done: false }> {
    const { timer } = this.options;
    let warnedPastCap = false;
    const result = await this.registryRetry.execute(step, {
      maxAttempts: Number.MAX_SAFE_INTEGER,
      signal: this.closing.signal,
      shouldRetry: () => !(stopWhen?.() ?? false),
      delays: (attempt) =>
        timer.now() >= deadline
          ? this.settlementSlowPollMs
          : this.registryRetryBackoff.delayForAttempt(attempt),
      onRetry: (error, attempt, delayMs) => {
        if (attempt === 1) {
          this.warn(
            `[ManagedExecutionRelease] ${what} failed; retrying in ${delayMs}ms: ${error.message}`,
            error,
          );
        }
        if (timer.now() >= deadline && !warnedPastCap) {
          warnedPastCap = true;
          this.warn(
            `[ManagedExecutionRelease] ${what} has kept failing past the ` +
              `${this.settlementCapMs}ms settlement cap; it is retried every ` +
              `${this.settlementSlowPollMs}ms until the registry recovers. ` +
              "`reset-slot-scope --force` or a daemon restart also recovers the slot: " +
              error.message,
            error,
          );
        }
      },
      expectedFailure: { reason: "the drain reports why it stopped retrying a registry step" },
    });
    if (result.success) {
      return { done: true, value: result.value as T };
    }
    if (!this.closed) {
      this.warn(
        `[ManagedExecutionRelease] ${what} failed and is no longer needed, so it is not ` +
          `retried: ${errorMessage(result.error)}`,
        result.error,
      );
    }
    return { done: false };
  }

  /**
   * The owner record still on a settled slot at its marked binding (#11545). A `settling` slot
   * accepts no claim, so the record predates the mark: it is the released session's own, left by
   * an owner clear that failed (a busy registry). Dead by liveness, the clear is retried and the
   * slot may return to `ready` either way, where a dead record pins nothing (#11339). A live owner
   * is never cleared. Resolves to whether the slot may be restored.
   */
  private async clearLeftoverOwner(
    registry: ManagedExecutionSlotRegistry,
    slot: MarkedSlot,
    owner: SlotExecOwner | null,
  ): Promise<boolean> {
    if (owner === null) {
      return true;
    }
    if (this.isExecOwnerLive(owner)) {
      return false;
    }
    try {
      await registry.releaseExecution(slot.key, owner.sessionUuid);
    } catch (error) {
      this.warn(
        `[ManagedExecutionRelease] Retrying the owner clear of slot ${slot.key.scopeKey}/` +
          `${slot.key.slotIndex} for ended session ${owner.sessionUuid} failed; the slot still ` +
          `returns to ready and the clear is retried: ${errorMessage(error)}`,
        error,
      );
      this.track(this.retryOwnerClear(registry, slot.key, owner.sessionUuid));
    }
    return true;
  }

  /**
   * Retry an owner clear that threw until it lands (#11545). The record it left names this
   * running process: this daemon reads it dead by its ended session, but every other daemon on
   * the host reads it live by process and answers `slot_in_use` for as long as this one runs, so
   * one busy write would pin the slot to them. The first retry waits one poll (the registry was
   * busy a moment ago); a registry step that throws is retried like every other step of the
   * drain, past the settlement cap at the slow cadence, and stops when this daemon closes.
   *
   * Only the ended session's own dead record is cleared. A record that is gone or names another
   * session ends the retry. One that reads live (this daemon holds the session id again, or a
   * drain still holds it) is re-checked at the fast cadence until the settlement cap and then
   * left to that holder, whose own release clears it.
   */
  private async retryOwnerClear(
    registry: ManagedExecutionSlotRegistry,
    key: SlotKey,
    sessionId: string,
  ): Promise<void> {
    const id = `${key.scopeKey}/${key.slotIndex}/${sessionId}`;
    if (this.closed || this.ownerClearRetries.has(id)) {
      return;
    }
    this.ownerClearRetries.add(id);
    const { timer } = this.options;
    const deadline = timer.now() + this.settlementCapMs;
    try {
      for (;;) {
        await timer.sleep(this.settlementPollMs);
        if (this.closed) {
          return;
        }
        const cleared = await this.retryRegistryStep(
          `Clearing the owner of slot ${key.scopeKey}/${key.slotIndex} for ended session ${sessionId}`,
          deadline,
          () => this.clearEndedOwnerOnce(registry, key, sessionId),
        );
        if (
          !cleared.done ||
          cleared.value === "done" ||
          timer.now() + this.settlementPollMs > deadline
        ) {
          return;
        }
      }
    } finally {
      this.ownerClearRetries.delete(id);
    }
  }

  /**
   * One attempt of {@link retryOwnerClear}; throws when the registry does. Nothing is awaited
   * between the liveness check and the clear, so a session this daemon comes to hold again is
   * either seen live here or claims the slot after the clear was issued.
   */
  private async clearEndedOwnerOnce(
    registry: ManagedExecutionSlotRegistry,
    key: SlotKey,
    sessionId: string,
  ): Promise<"done" | "owner_live"> {
    const owner = (await registry.getAssignment(key))?.execOwner ?? null;
    if (owner === null || owner.sessionUuid !== sessionId) {
      return "done";
    }
    if (this.options.sessions.isSessionLive(sessionId) || this.isExecOwnerLive(owner)) {
      return "owner_live";
    }
    await registry.releaseExecution(key, sessionId);
    return "done";
  }

  /** Return a settled slot to `ready`, closing its release journal entry in the same transaction. */
  private async restoreSlotState(registry: ManagedExecutionSlotRegistry, slot: MarkedSlot) {
    const binding = { generation: slot.generation, stableDeviceId: slot.stableDeviceId };
    const journal = this.options.journal;
    if (!journal || slot.journalEntryId === undefined) {
      return registry.updateSlotState(slot.key, binding, "ready");
    }
    // A throw keeps the entry guarded in flight: the watcher retries it (#11616).
    const advanced = await registry.advanceSlotJournal(slot.journalEntryId, {
      owner: this.settlerIdentity(),
      expectedPhase: "intent",
      phase: "committed",
      assignment: { kind: "state", expected: binding, state: "ready" },
    });
    journal.inFlight.delete(slot.journalEntryId);
    return advanced;
  }

  /**
   * The slot moved on before settlement: close its release entry (rolled back when the binding
   * changed, committed when something else already restored it). A slot with a live execution
   * owner keeps its entry open for redrive; a dead owner record holds nothing open (#11545).
   * A slot still `settling` at its mark never comes here: {@link restoreOnceUnowned} re-checks it.
   */
  private async closeSupersededEntry(
    registry: ManagedExecutionSlotRegistry,
    slot: MarkedSlot,
    current: SlotAssignmentRecord | null,
  ): Promise<void> {
    const journal = this.options.journal;
    const owner = current?.execOwner ?? null;
    if (!journal || slot.journalEntryId === undefined || (owner && this.isExecOwnerLive(owner))) {
      return;
    }
    const rebound =
      !current ||
      current.generation !== slot.generation ||
      current.stableDeviceId !== slot.stableDeviceId;
    // A throw keeps the entry guarded in flight: the watcher retries it (#11616).
    await registry.advanceSlotJournal(slot.journalEntryId, {
      owner: this.settlerIdentity(),
      expectedPhase: "intent",
      phase: rebound ? "rolled_back" : "committed",
    });
    journal.inFlight.delete(slot.journalEntryId);
  }

  /**
   * Keep `sessionId`'s owner records reading live until the returned release runs (idempotent).
   * Counted, so overlapping holders of one session id never drop each other's hold.
   *
   * Once this daemon has closed, a hold whose work (on `deviceId`) is still running is kept, not
   * released: the drain stops there without fencing or clearing anything, and the process, which
   * can outlive the close, must not read its own record as dead under that work. The hold then
   * lasts as long as the process does.
   */
  private holdOwner(sessionId: string, deviceId: string | null): () => void {
    const holders = this.ownerHoldCounts.get(sessionId) ?? 0;
    this.ownerHoldCounts.set(sessionId, holders + 1);
    if (holders === 0) {
      this.ownerHolds.add(sessionId);
    }
    let released = false;
    return () => {
      if (released || (this.closed && !this.isSettled(sessionId, deviceId))) {
        return;
      }
      released = true;
      const remaining = (this.ownerHoldCounts.get(sessionId) ?? 1) - 1;
      if (remaining > 0) {
        this.ownerHoldCounts.set(sessionId, remaining);
        return;
      }
      this.ownerHoldCounts.delete(sessionId);
      this.ownerHolds.delete(sessionId);
    };
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

  /** Warn, unless this daemon has closed: a step that was in flight then reports nothing. */
  private warn(message: string, error?: unknown): void {
    if (this.closed) {
      return;
    }
    if (error === undefined) {
      logger.warn(message);
    } else {
      logger.warn(message, error);
    }
  }

  private track(task: Promise<void>): void {
    const tracked = task
      .catch((error: unknown) => {
        this.warn(
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
  releaseSession(sessionId: string, reason?: SessionReleaseReason): Promise<string | null>;
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
