import type { ScreenLockReleaseReport } from "../../screenLockSessionCleanup";
import type { PowerReleaseReport } from "../../powerSessionCleanup";
import { type BackoffPolicy, exponentialBackoff } from "../../../utils/Backoff";
import type { KeepAwakeRestoreReport } from "../../../utils/KeepScreenAwakeManager";
import type { Timer } from "../../../utils/SystemTimer";
import type { SessionReleaseReason } from "../../releaseReasons";
import {
  forceStuckSessionRelease,
  releaseSessionAndDevice,
  type SessionReleasePool,
} from "../../releaseSessionAndDevice";
import type { SessionManager } from "../../sessionManager";
import type { BindingJournalInFlight } from "../registry/bindingJournal";
import type {
  BindingAssignmentRecord,
  BindingAssignmentState,
  BindingExecOwnerLiveness,
  BindingKey,
  BindingPlatform,
  BindingProcessIdentity,
  BindingRegistry,
} from "../registry/bindingRegistry";
import {
  REGISTRY_RETRY_INITIAL_DELAY_MS,
  REGISTRY_RETRY_MAX_BLOCKED_WAIT_MS,
  REGISTRY_RETRY_MAX_DELAY_MS,
} from "../registry/registryRetryPacing";

export type BrokerExecutionReleaseOutcome = "reusable_for_this_binding" | "cleanup_pending";

/**
 * `confirmed`: nothing the execution started is still running. `settling`: cancellation was
 * requested but some work (an action, or the release's restoration) has not ended yet.
 */
export type ManagedExecutionSettlement = "confirmed" | "settling";

/** One binding the released execution held, as it stands after the release. */
export interface ManagedExecutionBindingEvidence {
  scopeKey: string;
  bindingIndex: number;
  role: string;
  platform: BindingPlatform;
  generation: number;
  stableDeviceId: string | null;
  deviceName: string | null;
  state: BindingAssignmentState;
  /** True when this release cleared the binding's execution owner (false when already cleared). */
  execOwnerReleased: boolean;
}

export interface ManagedExecutionBindingFailure {
  scopeKey: string;
  bindingIndex: number;
  error: string;
}

export interface BrokerExecutionReleaseResult {
  keepAwakeRestore?: KeepAwakeRestoreReport;
  /** How clearing the lock-screen credential the session set went (#14107). */
  screenLockRestore?: ScreenLockReleaseReport;
  /** How restoring the battery, Doze, standby, saver and thermal changes the session made went (#14084). */
  powerRestore?: PowerReleaseReport;
  sessionId: string;
  outcome: BrokerExecutionReleaseOutcome;
  settlement: ManagedExecutionSettlement;
  /** The session was no longer live when this release arrived (a repeated or late release). */
  alreadyReleased: boolean;
  /** How many in-flight executions this release asked to cancel. */
  cancellationRequested: number;
  /** The session's release outlived its budget and was forced into the stuck-release quarantine. */
  releaseForced: boolean;
  /** The device the session held, when known. Still assigned to its binding. */
  device: string | null;
  bindings: ManagedExecutionBindingEvidence[];
  /** Per-binding bookkeeping that failed; every other binding was still released. */
  bindingFailures: ManagedExecutionBindingFailure[];
}

/** The registry slice the drain needs. */
export type ManagedExecutionBindingRegistry = Pick<
  BindingRegistry,
  | "findExecutionAssignments"
  | "claimExecution"
  | "releaseExecution"
  | "updateBindingState"
  | "getAssignment"
  | "recoverSettledBindings"
  | "openBindingJournal"
  | "advanceBindingJournal"
  | "listOpenBindingJournal"
>;

/**
 * Journal the drain's `settling` marks (#11179): each mark opens a `release` entry owned by this
 * daemon (the settler) in the same transaction, closed when the binding returns to `ready`. A daemon
 * that dies before its work settles leaves the entry for a later daemon's redrive.
 */
export interface BrokerExecutionReleaseJournal {
  /** Entries this drain is still guarding; a redrive in this process leaves them alone. */
  inFlight: BindingJournalInFlight;
}

/** The execution-tracker slice the drain needs (cancel, bounded wait, and a settled probe). */
export interface ManagedExecutionWork {
  cancelDeviceSessionExecutions(sessionId: string, reason: string): Promise<number>;
  waitForDeviceSessionExecutionsToEnd(sessionId: string, timeoutMs: number): Promise<boolean>;
  hasActiveDeviceSessionExecutions(sessionId: string): boolean;
}

/** The session-manager and pool slice the drain needs. */
export interface ManagedExecutionSessions extends Partial<
  Pick<SessionManager, "getKeepAwakeRestoreReport">
> {
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
export interface BrokerExecutionReleaseNotice {
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
 * How long the watcher polls unsettled work at the fast cadence. Past it the binding stays `settling`
 * and the watcher keeps going at {@link MANAGED_EXECUTION_SETTLEMENT_SLOW_POLL_MS}, so the binding
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

/** Released sessions remembered so a repeated release can still name its bindings. */
export const RECENT_RELEASE_LIMIT = 256;

export const RELEASE_REASON = "managed-execution-release";

export const MANAGED_SETTLED_BINDING_RECOVERY_RETRY_INITIAL_DELAY_MS =
  REGISTRY_RETRY_INITIAL_DELAY_MS;

export const MANAGED_SETTLED_BINDING_RECOVERY_RETRY_MAX_DELAY_MS = REGISTRY_RETRY_MAX_DELAY_MS;

export const MANAGED_SETTLED_BINDING_RECOVERY_RETRY_MAX_BLOCKED_WAIT_MS =
  REGISTRY_RETRY_MAX_BLOCKED_WAIT_MS;

export const MANAGED_SETTLED_BINDING_RECOVERY_WARN_AFTER_MS = 5_000;

/**
 * Session ids whose owner records this daemon must keep reading as live although the session is
 * gone: the released work still runs and its binding's `settling` mark has not been written yet
 * (#11616). The daemon's owner liveness (`withLiveExecutionSessions`) reads the same set as its
 * in-flight reservations, so the registry refuses a claim of such a binding.
 */
export interface ManagedExecutionOwnerHolds {
  add(sessionId: string): void;
  delete(sessionId: string): void;
}

export interface BrokerExecutionReleaseOptions {
  registry: () => Promise<ManagedExecutionBindingRegistry>;
  work: ManagedExecutionWork;
  sessions: ManagedExecutionSessions;
  timer: Timer;
  drainBudgetMs?: number;
  releaseBudgetMs?: number;
  settlementPollMs?: number;
  settlementCapMs?: number;
  settlementSlowPollMs?: number;
  /** This daemon, recorded as the settler of bindings it marks `settling`. Default: this process. */
  settler?: BindingProcessIdentity;
  journal?: BrokerExecutionReleaseJournal;
  /**
   * Judges an owner record left on a binding this drain marked `settling` (#11545): pass the
   * registry's own predicate, so the watcher and the registry agree. Default: PID plus process
   * start identity, under which a record this daemon wrote always reads live and is never cleared.
   */
  isExecOwnerLive?: BindingExecOwnerLiveness;
  /** Backoff between retries of a registry step that threw. Default: 250 ms doubling to 5 s. */
  registryRetryBackoff?: BackoffPolicy;
  /**
   * Where the drain records the released sessions whose owner records must still read live.
   * Default: the process-wide set the daemon's owner liveness reads.
   */
  ownerHolds?: ManagedExecutionOwnerHolds;
  ownership?: {
    isReleaseHeld(sessionId: string): boolean;
    confirmOwnership(sessionId: string): void;
    loseOwnership?(sessionId: string): void;
  };
}

export interface MarkedBinding {
  execOwner: BindingAssignmentRecord["execOwner"];
  key: BindingKey;
  generation: number;
  stableDeviceId: string | null;
  /** The release journal entry recording the mark, when journaling is on. */
  journalEntryId?: number;
}

/** The `settling` marks of one release: the bindings fenced, and the ones whose mark threw (owed). */
export interface SettlingMarks {
  marked: MarkedBinding[];
  owed: BindingAssignmentRecord[];
  /** Bindings whose owner record names this daemon, or needs no re-stamp. */
  stamped: Set<BindingAssignmentRecord>;
  /** A failed re-stamp was already reported for this release. */
  stampWarned: boolean;
}

export function newSettlingMarks(): SettlingMarks {
  return { marked: [], owed: [], stamped: new Set(), stampWarned: false };
}

/** What a mark attempt came to when it did not throw: fenced, refused, or not journaled. */
export type MarkAttempt = MarkedBinding | { refused: string };

export function bindingKeyOf(assignment: BindingKey): BindingKey {
  return { scopeKey: assignment.scopeKey, bindingIndex: assignment.bindingIndex };
}

export function toEvidence(
  assignment: BindingAssignmentRecord,
  execOwnerReleased: boolean,
): ManagedExecutionBindingEvidence {
  return {
    scopeKey: assignment.scopeKey,
    bindingIndex: assignment.bindingIndex,
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
export interface ManagedExecutionSessionManager extends Partial<
  Pick<SessionManager, "getKeepAwakeRestoreReport">
> {
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
 * where generic exclusion still keeps it to its binding), and a stuck release through
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
    getKeepAwakeRestoreReport: (sessionId) => manager.getKeepAwakeRestoreReport?.(sessionId),
    releaseSession: async (sessionId) => {
      let deviceId = deviceOf(sessionId);
      await releaseSessionAndDevice({ manager, pool }, deviceId, sessionId, {
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
