import type { CleanupReceiptOwner, CleanupReceiptRecorder } from "../sessionCleanupReceipts";
import {
  DeviceSessionRowNotRewritableError,
  type DeviceSessionPersistence,
  type UpsertActiveSessionOptions,
} from "../../db/deviceSessionRepository";
import type { DeviceSession } from "../../db/types";
import { type IosAppNetworkRule } from "../../features/networkFilter/IosAppNetworkRuleClient";
import { type Platform } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import {
  DeviceOwnedByOtherDaemonError,
  SessionReleasedDuringCreationError,
} from "../../models/deviceAcquisitionRefusals";
import {
  getAbortSignal,
  runOutsideRequestContext,
  runWithAbortSignal,
} from "../../utils/AbortContext";
import { type BackoffPolicy } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { type Timer } from "../../utils/SystemTimer";
import { type DeferredRebindCleanup } from "../acquisitionReceipt";
import { type AbandonablePendingDeviceCleanup } from "../deviceCleanupQuarantine";
import type { DeviceHealthMarkers } from "../deviceHealthMarkers";
import {} from "../deviceStateRestoreQueue";
import { isTerminalReleaseReason } from "../releaseReasons";
import { SessionDeviceStateRestore } from "../sessionDeviceStateRestore";
import { TerminalSessionError } from "../sessionErrors";
import { SessionLivenessController } from "../sessionLivenessLease";
import {
  getDefaultPreFirstHeartbeatGraceMs,
  RehydrationSummary,
  releaseWasForced,
  Session,
  SessionDeviceAssigner,
  SessionRecoveryTarget,
  SessionReleaseOperation,
  SessionReleaseOptions,
  SessionReleaseSnapshot,
} from "../sessionManager";
import {
  type RehydrationRowOutcome,
  type SharedSessionAssignment,
} from "../sessionManager/internalContracts";
import { SessionRecoveryIdentityLossError } from "../sessionManager/SessionRecoveryIdentityLossError";
import { type SessionRowWriter } from "../sessionRowWriter";
import type { SupersededRowReasserts } from "../supersededRowReasserts";
import { type SessionLifecycleSlots } from "./internalContracts";

export interface SessionRecoveryPublicationHost {
  readonly cleanupReceipts: Pick<CleanupReceiptRecorder, "trackOwner">;
  recoveryTargetFromPersisted(
    sessionId: string,
    persisted: DeviceSession | undefined,
    requestedPlatform: Platform | undefined,
    callerInFlight: boolean,
  ): Promise<SessionRecoveryTarget | undefined>;
  isNameReissueOnlyRow(persisted: DeviceSession | undefined): boolean;
  readonly sessionSlots: SessionLifecycleSlots;
  assignUnseenSessionToDevicePool(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    platform: Platform | undefined,
    recoveryTarget: SessionRecoveryTarget | undefined,
    persisted: DeviceSession | undefined,
  ): Promise<void>;
  sessionNow(): number;
  getSession(sessionId: string): Session | null;
  readonly restartRecoveryActivityAt: Map<string, number>;
  settleManagedExecutionRecovery(sessionId: string, completed: boolean): void;
  isRecoverablePersistedSession(persisted: DeviceSession | undefined): boolean;
  rehydrationSkipReason(sessionId: string): string | undefined;
  registerRehydrationRecovery(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    persisted: DeviceSession,
    signal?: AbortSignal,
  ): Promise<Session>;
  getTerminalReleaseSnapshot(sessionId: string): SessionReleaseSnapshot | undefined;
  readonly deviceSessionRepository: DeviceSessionPersistence;
  rowWriteLivePeerDaemonSessionIds(): string[];
  readonly timer: Timer;
  persistTerminalReleaseIfNeeded(snapshot: SessionReleaseSnapshot): Promise<void>;
  captureReleaseRowGeneration(
    snapshot: SessionReleaseSnapshot,
    rowGeneration: number | undefined,
  ): void;
  readonly sessionSetupPromises: Set<{ session: Session; promise: Promise<void> }>;
  waitForSessionSetup(
    sessionId: string,
    setups: readonly Promise<void>[],
    phase?: "release" | "rebind",
  ): Promise<{ pending: Promise<void> | null }>;
  readonly liveness: SessionLivenessController;
  persistSession(
    session: Session,
    incarnation: Session,
    upsertOptions?: UpsertActiveSessionOptions,
    upsertSettled?: () => void,
  ): Promise<void>;
  createReboundSession(
    session: Session,
    assignedDevice: string,
    platform: Platform,
    stableDeviceId: string | undefined,
  ): Session;
  guardedRowRewriteOptions(
    supersededReasons: readonly string[],
    expectedRowGeneration?: number,
  ): UpsertActiveSessionOptions;
  readonly superseded: SupersededRowReasserts<Session>;
  readonly sessions: Map<string, Session>;
  restoreReleasedRowAfterReassert(session: Session): Promise<void>;
  readonly identityReplacementFences: Map<
    string,
    { releases: Set<SessionReleaseOperation>; settled: Promise<void>; resume: () => void }
  >;
  readonly stateRestore: SessionDeviceStateRestore;
  readonly replacedRestoreGenerations: Map<string, number>;
  readonly deviceHealth:
    | {
        markers: DeviceHealthMarkers;
        incarnation: (deviceId: string) => number | undefined;
        canRecover: (deviceId: string) => boolean;
        backoff: BackoffPolicy;
      }
    | undefined;
  getSessionForDevice(deviceId: string): string | null;
  restoreIncarnationIsCurrent(target: {
    deviceId: string;
    incarnation?: number;
    restoreGeneration?: number;
  }): boolean;
  waitForIdentityReplacement(deviceId: string, generation: number): Promise<boolean>;
  notifySessionDeviceUnbound(
    sessionId: string,
    deviceId: string,
    options?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void;
  restoreRebindOverrides(existing: Session, mayRestore?: () => boolean): Promise<Promise<void>[]>;
  trackPendingTeardownCleanup(deviceId: string, cleanups: readonly Promise<void>[]): void;
  registerPendingDeviceCleanup(
    deviceId: string,
    cleanup: Promise<unknown>,
    bound?: number | AbandonablePendingDeviceCleanup,
  ): void;
  deferRebindOverrides(
    oldView: Session,
    resumeRetainedState: () => void,
    lease: IosAppNetworkRule | undefined,
  ): DeferredRebindCleanup;
  readonly rowWriter: SessionRowWriter;
  readonly deviceSessionMap: Map<string, string>;
  cancelSessionlessUseOnAcquisition(deviceId: string, sessionId: string): void;
  notifyDeviceOwnershipChange(
    deviceId: string,
    frameInvalidation?: "generation-only" | "full",
  ): void;
  readonly activeRestoreControllers: Map<string, Set<AbortController>>;
  endSessionTerminallyReleasedInRow(session: Session): Promise<Error>;
  trackReleaseDrainWrite(write: Promise<void>): void;
}

export class SessionRecoveryPublication {
  constructor(private readonly host: SessionRecoveryPublicationHost) {}

  async recoverPersistedRow(
    sessionId: string,
    devicePool: SessionDeviceAssigner,
    platform: Platform | undefined,
    persisted: DeviceSession | undefined,
    initialOwnership: "owned" | "awaiting-owner",
    shared: SharedSessionAssignment,
  ): Promise<Session> {
    const recoveryTarget = await this.host.recoveryTargetFromPersisted(
      sessionId,
      persisted,
      platform,
      initialOwnership === "owned",
    );
    if (recoveryTarget && initialOwnership === "awaiting-owner") {
      recoveryTarget.initialOwnership = initialOwnership;
    }
    logger.info(
      `[SessionManager] Creating new session ${sessionId}, calling devicePool.assignDeviceToSession()`,
    );
    // A re-issue with no usable target still writes over its claimed row, as a recovery does.
    if (persisted && (recoveryTarget || this.host.isNameReissueOnlyRow(persisted))) {
      this.host.sessionSlots.setRecovery(sessionId, persisted);
    }
    try {
      const assign = () =>
        this.host.assignUnseenSessionToDevicePool(
          sessionId,
          devicePool,
          platform,
          recoveryTarget,
          persisted,
        );
      if (
        recoveryTarget?.restartRecoveryDeadlineMs !== undefined &&
        this.host.sessionNow() < recoveryTarget.restartRecoveryDeadlineMs
      ) {
        recoveryTarget.onRecoveryWait = (wait) => shared.recoveryWait.resolve(wait);
        await runWithAbortSignal(shared.controller.signal, assign);
      } else {
        shared.recoveryWait.resolve(undefined);
        await assign();
      }
      const session = this.host.getSession(sessionId);
      if (!session) {
        throw new SessionReleasedDuringCreationError(sessionId);
      }
      // The live session's own clocks take over from here.
      this.host.restartRecoveryActivityAt.delete(sessionId);
      logger.info(
        `[SessionManager] Successfully created session ${sessionId} with device ${session.assignedDevice}`,
      );
      this.host.settleManagedExecutionRecovery(sessionId, true);
      return session;
    } finally {
      // A successful recovery already resolved; every other exit rejects and drops its signal.
      this.host.settleManagedExecutionRecovery(sessionId, false);
      if (this.host.sessionSlots.getRecovery(sessionId) === persisted) {
        this.host.sessionSlots.deleteRecovery(sessionId);
      }
    }
  }

  async rehydratePersistedRow(
    persisted: DeviceSession,
    devicePool: SessionDeviceAssigner,
    signal?: AbortSignal,
  ): Promise<RehydrationRowOutcome> {
    const sessionId = persisted.session_uuid;
    if (!this.host.isRecoverablePersistedSession(persisted)) {
      return { kind: "skipped", reason: "not-recoverable" };
    }
    const skipReason = this.host.rehydrationSkipReason(sessionId);
    if (skipReason) {
      return { kind: "skipped", reason: skipReason };
    }
    try {
      await this.host.registerRehydrationRecovery(sessionId, devicePool, persisted, signal);
      return { kind: "rehydrated" };
    } catch (error) {
      const terminalRelease = this.host.getTerminalReleaseSnapshot(sessionId);
      if (terminalRelease) {
        return { kind: "terminalized", reason: terminalRelease.releaseReason };
      }
      if (error instanceof DeviceOwnedByOtherDaemonError) {
        // Another live daemon took the row or its device; that daemon recovers the session.
        return { kind: "skipped", reason: "owned-by-other-daemon" };
      }
      const reason = errorMessage(error);
      logger.warn(`[SessionManager] Failed to rehydrate session ${sessionId}: ${reason}`);
      return { kind: "skipped", reason };
    }
  }

  async listRecoverableSessionsBeforeDeadline(
    deadlineAt: number,
    summary: RehydrationSummary,
  ): Promise<DeviceSession[]> {
    const deadlineWon = Symbol("startup-deadline");
    const recoverableSessions = this.host.deviceSessionRepository.listRecoverableSessions(
      this.host.sessionNow(),
      () => this.host.rowWriteLivePeerDaemonSessionIds(),
    );
    let result: typeof deadlineWon | DeviceSession[];
    try {
      result = await raceWithDeadline(recoverableSessions, {
        timer: this.host.timer,
        timeoutMs: Math.max(0, deadlineAt - this.host.sessionNow()),
        label: "Recoverable session listing",
        timeoutError: () => deadlineWon,
      });
    } catch (error) {
      if (error !== deadlineWon) {
        throw error;
      }
      result = deadlineWon;
    }
    if (typeof result !== "symbol") {
      return result;
    }
    void recoverableSessions.catch((error) =>
      logger.warn(
        `[SessionManager] Recoverable-session list continued after startup deadline: ${errorMessage(error)}`,
      ),
    );
    summary.timedOut = true;
    logger.warn("[SessionManager] Startup rehydration deadline reached while listing rows");
    return [];
  }

  async terminalizePersistedRecoveryFailure(
    sessionId: string,
    persisted: DeviceSession,
    error: Pick<SessionRecoveryIdentityLossError, "terminalReleaseReason"> &
      Partial<Pick<SessionRecoveryIdentityLossError, "ownerPid">>,
  ): Promise<void> {
    const releasedAtMs = this.host.sessionNow();
    await this.host.persistTerminalReleaseIfNeeded({
      sessionId,
      deviceId: persisted.device_id,
      releaseReason: error.terminalReleaseReason,
      releasedAtMs,
      terminal: true,
      ...(error.ownerPid === undefined ? {} : { ownerPid: error.ownerPid }),
      heartbeat: {
        lastHeartbeatMs: persisted.last_used_at_ms,
        hasReceivedHeartbeat: persisted.has_received_heartbeat === 1,
        timeoutMs: persisted.heartbeat_timeout_ms,
        ageMs: Math.max(0, releasedAtMs - persisted.last_used_at_ms),
      },
    });
  }

  releaseSnapshotFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
    releaseReason: string,
  ): SessionReleaseSnapshot {
    const releasedAtMs = persisted.released_at_ms ?? persisted.last_used_at_ms;
    const snapshot: SessionReleaseSnapshot = {
      sessionId,
      deviceId: persisted.device_id,
      releaseReason,
      releasedAtMs,
      terminal: isTerminalReleaseReason(releaseReason),
      heartbeat: {
        lastHeartbeatMs: persisted.last_used_at_ms,
        hasReceivedHeartbeat: persisted.has_received_heartbeat === 1,
        // Match the live snapshot: a missing-first-heartbeat reap is governed by
        // the pre-first-heartbeat grace, not the stored heartbeat timeout.
        timeoutMs:
          releaseReason === "missing-first-heartbeat"
            ? getDefaultPreFirstHeartbeatGraceMs()
            : persisted.heartbeat_timeout_ms,
        ageMs: Math.max(0, releasedAtMs - persisted.last_used_at_ms),
      },
    };
    this.host.captureReleaseRowGeneration(snapshot, persisted.stable_identity_generation);
    return snapshot;
  }

  async persistAndPublishRebind(
    existing: Session,
    assignedDevice: string,
    platform: Platform,
    stableDeviceId: string | undefined,
    deferCleanup?: (cleanup: DeferredRebindCleanup) => void,
  ): Promise<Session> {
    const activeSetups = Array.from(this.host.sessionSetupPromises, (setup) =>
      setup.session === existing ? setup.promise : null,
    ).filter((setup): setup is Promise<void> => setup !== null);
    // Keep the old binding when setup cannot settle: a late mutation could
    // otherwise dirty the old simulator after its restore and pool release.
    const setupDrain = await this.host.waitForSessionSetup(
      existing.sessionId,
      activeSetups,
      "rebind",
    );
    if (setupDrain.pending) {
      throw new ActionableError(
        `Session ${existing.sessionId} setup is still running; retry the device rebind after it settles.`,
      );
    }
    await this.host.liveness.livenessOwnershipClaimMutexFor(existing).runExclusive(async () => {
      await this.host.persistSession(
        this.host.createReboundSession(existing, assignedDevice, platform, stableDeviceId),
        existing,
        this.host.guardedRowRewriteOptions([...(this.host.superseded.remembered(existing) ?? [])]),
      );
      // The rebind's row is live: a rewrite still owed from before it is settled (#11557), so a
      // terminal row found under the session later is the UUID's end, not that rewrite's.
      this.host.superseded.settle(existing);
    });
    if (this.host.sessions.get(existing.sessionId) !== existing) {
      // A release waits for the rebind, but a forced one does not (#10963): it removed the
      // session and wrote its row while this row was in flight, and this row landed over it.
      await this.host.restoreReleasedRowAfterReassert(existing);
    }
    const previousDevice = existing.assignedDevice;
    const replacementFence = this.host.identityReplacementFences.get(previousDevice);
    const oldView: Session = { ...existing, cacheData: { ...existing.cacheData } };
    const expiry = this.host.stateRestore.peekNetworkConditionExpiry(existing.sessionId);
    const lease = this.host.stateRestore.activeIosAppNetworkLease(existing.sessionId);
    // These callbacks read the live session. Suspend TTL and transfer lease renewal before
    // publishing B, so neither can address B with A's state. Undo resumes the original deadline.
    this.host.stateRestore.cancelNetworkConditionExpiry(existing.sessionId);
    this.host.stateRestore.stopIosAppNetworkLease(existing.sessionId);
    // A replaced release waits for this rebind: its restore fence must not hold up the rebind.
    if (replacementFence) {
      const generation = this.host.replacedRestoreGenerations.get(previousDevice) ?? 0;
      const incarnation = this.host.deviceHealth?.incarnation(previousDevice);
      const releases = [...replacementFence.releases];
      const mayRestore = () => {
        const holder = this.host.getSessionForDevice(previousDevice);
        return (
          (holder === null || holder === oldView.sessionId) &&
          this.host.restoreIncarnationIsCurrent({
            deviceId: previousDevice,
            incarnation,
            restoreGeneration: generation,
          })
        );
      };
      // The pending release owns the handoff verdict. Retain A's view until its fence settles,
      // without making the rebind (which that release awaits) wait for restoration.
      const cleanup = runOutsideRequestContext(async () => {
        const current = await this.host.waitForIdentityReplacement(previousDevice, generation);
        const replaced = !current || releases.some(releaseWasForced) || !mayRestore();
        this.host.notifySessionDeviceUnbound(oldView.sessionId, previousDevice, {
          deviceIdentityReplaced: replaced,
        });
        if (replaced) {
          return;
        }
        const pending = await this.host.restoreRebindOverrides(oldView, mayRestore);
        this.host.trackPendingTeardownCleanup(previousDevice, pending);
        await Promise.allSettled(pending);
      }).catch((error: unknown) => {
        logger.warn(
          `Fenced rebind cleanup failed on ${previousDevice}: ${errorMessage(error)}`,
          error,
        );
      });
      this.host.registerPendingDeviceCleanup(previousDevice, cleanup);
    } else if (deferCleanup) {
      const cleanup = this.host.deferRebindOverrides(
        oldView,
        () => {
          if (expiry) {
            this.host.stateRestore.rearmNetworkConditionExpiry(existing, expiry);
          }
          if (lease) {
            this.host.stateRestore.confirmIosAppNetworkRule(existing, lease);
          }
        },
        lease,
      );
      deferCleanup(cleanup);
    } else {
      const pending = await this.host.restoreRebindOverrides(
        existing,
        () => !this.host.identityReplacementFences.has(previousDevice),
      );
      if (pending.length > 0) {
        this.host.trackPendingTeardownCleanup(previousDevice, pending);
      }
    }
    // Preserve object identity so an already-started release observes the
    // rebinding and frees its live replacement rather than a stale snapshot.
    // Recreate after awaited work to preserve activity and label-routing updates made in flight.
    Object.assign(
      existing,
      this.host.createReboundSession(existing, assignedDevice, platform, stableDeviceId),
    );
    const sessionId = existing.sessionId;
    this.host.rowWriter.noteLive(sessionId);
    if (this.host.deviceSessionMap.get(previousDevice) === existing.sessionId) {
      this.host.deviceSessionMap.delete(previousDevice);
    }
    this.host.deviceSessionMap.set(assignedDevice, existing.sessionId);
    if (assignedDevice !== previousDevice) {
      this.host.cancelSessionlessUseOnAcquisition(assignedDevice, existing.sessionId);
    }
    // Full: different-serial rebinds switch runtimes; same-serial force explicitly
    // means a restarted runtime. Terminal-release recovery also forces this path.
    this.host.notifyDeviceOwnershipChange(previousDevice, "full");
    if (assignedDevice !== previousDevice) {
      // Full: the replacement (including the same AVD on another serial) has its own screen.
      this.host.notifyDeviceOwnershipChange(assignedDevice, "full");
    }
    if (!replacementFence) {
      this.host.notifySessionDeviceUnbound(existing.sessionId, previousDevice, {
        deviceIdentityReplaced: this.host.identityReplacementFences.has(previousDevice),
      });
    }
    return existing;
  }

  dispatchDeviceRestoreWithReceipt(
    deviceId: string,
    restore: (
      signal: AbortSignal,
      identitySignal: AbortSignal,
      acknowledge: () => void,
    ) => Promise<void>,
    generation = this.host.replacedRestoreGenerations.get(deviceId) ?? 0,
    teardownStep?: number,
    owner?: CleanupReceiptOwner,
  ): Promise<void> {
    const work = this.dispatchDeviceRestore(deviceId, restore, generation, teardownStep);
    if (owner) {
      this.host.cleanupReceipts.trackOwner(owner, work);
    }
    return work;
  }

  /** Pause rather than consume a retry: a superseded handoff still owns its original baseline. */

  async dispatchDeviceRestore(
    deviceId: string,
    restore: (
      signal: AbortSignal,
      identitySignal: AbortSignal,
      acknowledge: () => void,
    ) => Promise<void>,
    generation = this.host.replacedRestoreGenerations.get(deviceId) ?? 0,
    teardownStep?: number,
  ): Promise<void> {
    if (this.host.identityReplacementFences.has(deviceId)) {
      if (!(await this.host.waitForIdentityReplacement(deviceId, generation))) {
        return;
      }
    } else if ((this.host.replacedRestoreGenerations.get(deviceId) ?? 0) !== generation) {
      return;
    }
    const controller = new AbortController();
    let controllers = this.host.activeRestoreControllers.get(deviceId);
    if (!controllers) {
      controllers = new Set();
      this.host.activeRestoreControllers.set(deviceId, controllers);
    }
    controllers.add(controller);
    const teardown = Array.from(this.host.sessionSlots.activeReleases)
      .filter(
        (release) =>
          teardownStep !== undefined &&
          release.teardownStep === teardownStep &&
          release.stage === "teardown" &&
          release.session.assignedDevice === deviceId,
      )
      .map((release) => ({ release, step: release.teardownStep }));
    try {
      // Clients still receive the ambient abort, but a successful late acknowledgement only
      // becomes a failed restore for identity replacement, as ordinary teardown did on main.
      const ambient = getAbortSignal();
      const signal = ambient ? AbortSignal.any([ambient, controller.signal]) : controller.signal;
      await runWithAbortSignal(signal, () =>
        restore(signal, controller.signal, () => {
          // An acknowledged write already restored A, even if its handoff mark is later revoked.
          for (const { release, step } of teardown) {
            if (release.identityReplacement && step !== undefined) {
              release.identityReplacement.resumeStep = Math.max(
                release.identityReplacement.resumeStep,
                step + 1,
              );
            }
          }
          controller.signal.throwIfAborted();
        }),
      );
    } finally {
      controllers.delete(controller);
      if (controllers.size === 0) {
        this.host.activeRestoreControllers.delete(deviceId);
      }
    }
  }

  async rejectRefusedRebind(
    existing: Session,
    rebind: { session: Session; promise: Promise<Session> },
    error: DeviceSessionRowNotRewritableError,
  ): Promise<never> {
    const sessionId = existing.sessionId;
    // The failed write never published its binding. End a terminal UUID after the rebind's
    // promise has rejected, so the release cannot wait on the very rebind adopting it.
    if (this.host.sessionSlots.getRebind(sessionId) === rebind) {
      this.host.sessionSlots.deleteRebind(sessionId);
    }
    const adoption = this.host.endSessionTerminallyReleasedInRow(existing);
    // Include the row read and any release it starts: the inner rebind already rejected.
    this.host.trackReleaseDrainWrite(
      adoption.then(
        () => {},
        (error: unknown) => {
          logger.warn(`[SessionManager] Rebind refusal adoption failed: ${errorMessage(error)}`);
        },
      ),
    );
    const terminal = await adoption;
    throw terminal instanceof TerminalSessionError ? terminal : error;
  }
}
