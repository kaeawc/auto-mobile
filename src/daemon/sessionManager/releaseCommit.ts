import { type MarkReleasedOptions } from "../../db/deviceSessionRepository";
import { toActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import {} from "../deviceStateRestoreQueue";
import {
  RELEASE_PERSIST_TIMEOUT_REASON,
  SessionReleasePersistTimeoutError,
} from "../releaseErrors";
import { isTerminalReleaseReason, resolveReleaseReason } from "../releaseReasons";
import { SessionDeviceStateRestore } from "../sessionDeviceStateRestore";
import {
  getDefaultPreFirstHeartbeatGraceMs,
  ReleaseCommitFence,
  releaseWasForced,
  Session,
  SessionReleaseOperation,
  SessionReleaseOptions,
  SessionReleaseSnapshot,
  SessionReleaseStage,
} from "../sessionManager";
import { ForcedStuckRelease } from "../sessionManager/forcedStuckRelease";
import { releaseSuperseded, type ReleaseReasonState } from "../sessionManager/internalContracts";
import { type SessionRowWriter } from "../sessionRowWriter";
import type { SupersededRowReasserts } from "../supersededRowReasserts";
import {
  managedExecutionReleaseMarker,
  setReleaseStage,
  type SessionLifecycleSlots,
} from "./internalContracts";

export interface SessionReleaseCommitHost {
  readonly stateRestore: SessionDeviceStateRestore;
  revokeSupersededIdentityReplacement(operation?: SessionReleaseOperation): boolean;
  abandonSupersededRelease(
    sessionId: string,
    deviceId: string,
    pendingCleanup: readonly Promise<void>[],
    liftTerminalFence?: boolean,
  ): null;
  sessionNow(): number;
  judgeOwnerLeaseForRelease(
    session: Session,
    reason: ReleaseReasonState,
    stage: "start" | "commit",
    operation?: SessionReleaseOperation,
  ): boolean;
  readonly sessionSlots: SessionLifecycleSlots;
  releaseHeartbeatTimeoutMs(releaseReason: string, session: Session): number;
  readonly releaseRowSessions: WeakMap<SessionReleaseSnapshot, WeakRef<Session>>;
  captureReleaseRowGeneration(
    snapshot: SessionReleaseSnapshot,
    rowGeneration: number | undefined,
  ): void;
  readonly persistedRowGenerations: WeakMap<Session, number>;
  persistTerminalReleaseWithinDeadline(
    snapshot: SessionReleaseSnapshot,
    reason: ReleaseReasonState,
    session: Session,
  ): Promise<{ snapshot: SessionReleaseSnapshot; persisted: boolean }>;
  abandonReleaseSupersededAfterPersist(
    session: Session,
    releaseSnapshot: SessionReleaseSnapshot,
    pendingCleanup: readonly Promise<void>[],
    liftTerminalFence: boolean,
  ): Promise<null>;
  readonly superseded: SupersededRowReasserts<Session>;
  commitReleaseRemoval(
    sessionId: string,
    session: Session,
    deviceId: string,
    pendingCleanup: readonly Promise<void>[],
  ): boolean;
  commitReplacedDeviceTeardown(
    sessionId: string,
    session: Session,
    options: SessionReleaseOptions,
    operation?: SessionReleaseOperation,
  ): void;
  readonly forcedStuckRelease: ForcedStuckRelease;
  restoreNonTerminalRowOverSupersededReleaseLater(
    session: Session,
    supersededReasons: readonly string[],
  ): void;
  notifySessionRelease(snapshot: SessionReleaseSnapshot, options?: SessionReleaseOptions): void;
  completeReleasePersistence(
    snapshot: SessionReleaseSnapshot,
    reason: ReleaseReasonState,
    session: Session,
    terminalPersisted: boolean,
  ): Promise<SessionReleaseSnapshot>;
  recordFinalizedSessionRelease(session: Session, reason: ReleaseReasonState): void;
  finishCommittedRelease(
    session: Session,
    reason: ReleaseReasonState,
    releaseSnapshot: SessionReleaseSnapshot,
    persistedSnapshot: SessionReleaseSnapshot,
    options: SessionReleaseOptions,
    pendingCleanup: readonly Promise<void>[],
  ): string;
  removeSession(sessionId: string, expectedSession?: Session): boolean;
  trackPendingTeardownCleanup(deviceId: string, cleanups: readonly Promise<void>[]): void;
  readonly replacedRestoreGenerations: Map<string, number>;
  dropReplacedDeviceRestoreState(session: Session, dropped: Set<string>): void;
  retireRestorations(deviceId: string, cause: "removal" | "incarnation-bump"): void;
  persistTerminalReleaseIfNeeded(snapshot: SessionReleaseSnapshot): Promise<void>;
  withReleaseReason(
    snapshot: SessionReleaseSnapshot,
    releaseReason: string,
    session?: Session,
  ): SessionReleaseSnapshot;
  persistTerminalReleaseWithUpgrade(
    snapshot: SessionReleaseSnapshot,
    reason: ReleaseReasonState,
    session: Session,
  ): Promise<SessionReleaseSnapshot>;
  readonly volatileTerminalReleaseIntents: Map<string, string>;
  liftTerminalFence(
    uuid: string,
    resolved?: Pick<SessionReleaseSnapshot, "releaseReason">,
    retainFence?: boolean,
    afterDelete?: () => void,
  ): void;
  reassertSupersededLiveRow(
    session: Session,
    supersededReasons: readonly string[],
  ): Promise<boolean>;
  upgradeReleaseReason(reason: ReleaseReasonState, candidate: string): void;
  readonly releaseRowGenerations: WeakMap<SessionReleaseSnapshot, number>;
  persistSessionRelease(
    snapshot: SessionReleaseSnapshot,
    retryPending?: boolean,
    statementConditions?: MarkReleasedOptions,
  ): Promise<boolean>;
  readonly rowWriter: SessionRowWriter;
  dropReleaseRetry(snapshot: SessionReleaseSnapshot): void;
  readonly finalizedSessionReleases: WeakMap<Session, ReleaseReasonState>;
}

export interface ReleaseSessionInternalRequest {
  sessionId: string;
  session: Session;
  reason: ReleaseReasonState;
  shouldCommit?: ReleaseCommitFence;
  options: SessionReleaseOptions;
  operation?: SessionReleaseOperation;
}

export class SessionReleaseCommit {
  constructor(private readonly host: SessionReleaseCommitHost) {}

  async releaseSessionInternal(request: ReleaseSessionInternalRequest): Promise<string | null> {
    const { sessionId, session, reason, shouldCommit, options, operation } = request;
    const enter = (stage: SessionReleaseStage) => setReleaseStage(operation, stage);
    try {
      enter("teardown");
      // Release restores the device to `none` itself, so a standalone TTL is now
      // redundant — cancel it first so the two restore paths cannot both fire
      // (issue #6085 item 2). Whichever runs first (this release, or the TTL that
      // already cleared the slot) wins.
      this.host.stateRestore.cancelNetworkConditionExpiry(sessionId);
      // Release removes the iOS app rule itself; stop renewing it first.
      this.host.stateRestore.stopIosAppNetworkLease(sessionId);
      let pendingCleanup = await this.host.stateRestore.drainReleaseTeardown(
        sessionId,
        session,
        operation,
        options,
      );
      while (this.host.revokeSupersededIdentityReplacement(operation)) {
        pendingCleanup = await this.host.stateRestore.drainReleaseTeardown(
          sessionId,
          session,
          operation,
          options,
        );
      }
      const deviceId = session.assignedDevice;
      // Forced while tearing down (#11058): the force already fenced the session and handed the
      // device back, so nothing here may commit, quarantine or notify for it.
      if (releaseWasForced(operation)) {
        return null;
      }
      // Setup/restoration awaits above are where a newer identity confirmation
      // can overtake a device-loss eviction. Fence before the terminal snapshot
      // is persisted so a declined release leaves no terminal trace behind.
      if (releaseSuperseded(shouldCommit)) {
        // releaseSessionAttempt always supplies its operation before entering teardown.
        operation!.commitDeclined = true;
        return this.host.abandonSupersededRelease(sessionId, deviceId, pendingCleanup);
      }
      const releasedAtMs = this.host.sessionNow();
      this.host.judgeOwnerLeaseForRelease(session, reason, "commit", operation);
      const releaseReason = reason.value;
      const terminalFenceHeldBefore = this.host.sessionSlots.hasTerminalSnapshot(sessionId);
      let releaseSnapshot: SessionReleaseSnapshot = {
        sessionId,
        deviceId,
        releaseReason,
        releasedAtMs,
        terminal: isTerminalReleaseReason(releaseReason),
        ...managedExecutionReleaseMarker(session),
        heartbeat: {
          lastHeartbeatMs: session.lastHeartbeat,
          hasReceivedHeartbeat: session.hasReceivedHeartbeat,
          // A missing-first-heartbeat reap fires on the pre-first-heartbeat grace,
          // not the session's heartbeat timeout; report the deadline that actually
          // governed the release so `ageMs` stays coherent (issue #5689). The grace
          // is resolved from the shared env/default here — matching the daemon's
          // monitor, which is constructed with default config. (A monitor given an
          // explicit `preFirstHeartbeatGraceMs`, as in tests, would diverge; drive
          // the grace via env to keep the snapshot consistent.)
          timeoutMs: this.host.releaseHeartbeatTimeoutMs(releaseReason, session),
          ageMs: Math.max(0, releasedAtMs - session.lastHeartbeat),
        },
      };
      this.host.releaseRowSessions.set(releaseSnapshot, new WeakRef(session));
      this.host.captureReleaseRowGeneration(
        releaseSnapshot,
        this.host.persistedRowGenerations.get(session),
      );

      // A non-terminal release must not yield after freezing its reason: a
      // concurrent terminal release can only upgrade the shared reason while
      // this operation is awaiting teardown above.
      let terminalPersisted = true;
      if (releaseSnapshot.terminal) {
        enter("terminal-persist");
        ({ snapshot: releaseSnapshot, persisted: terminalPersisted } =
          await this.host.persistTerminalReleaseWithinDeadline(releaseSnapshot, reason, session));
      }
      while (this.host.revokeSupersededIdentityReplacement(operation)) {
        pendingCleanup = await this.host.stateRestore.drainReleaseTeardown(
          sessionId,
          session,
          operation,
          options,
        );
      }
      if (releaseWasForced(operation)) {
        return null;
      }
      // Final fence: evaluated synchronously right before the commit, with no
      // await in between, so the persistence awaits above cannot hide a newer
      // confirmation either. A terminal fence this release raised is lifted so
      // the live session keeps routing, and the terminal row it wrote is
      // rewritten live so a restart rehydrates it (#11206).
      if (releaseSuperseded(shouldCommit)) {
        operation!.commitDeclined = true;
        return await this.host.abandonReleaseSupersededAfterPersist(
          session,
          releaseSnapshot,
          pendingCleanup,
          !terminalFenceHeldBefore,
        );
      }
      const owedReasons = this.host.superseded.reasonsOwedTo(session);
      if (!this.host.commitReleaseRemoval(sessionId, session, deviceId, pendingCleanup)) {
        return null;
      }
      this.host.commitReplacedDeviceTeardown(sessionId, session, options, operation);
      if (!releaseSnapshot.terminal) {
        this.host.forcedStuckRelease.liftTerminalFenceIfPresent(sessionId);
        this.host.sessionSlots.deleteTerminalReasonState(sessionId);
        // The removal dropped the rewrite owed over a superseded release's terminal row, and
        // this release's own write does not replace a terminal row.
        this.host.restoreNonTerminalRowOverSupersededReleaseLater(session, owedReasons);
      }

      this.host.notifySessionRelease(releaseSnapshot, options);
      enter("finalize-persist");
      let persistedSnapshot: SessionReleaseSnapshot;
      try {
        persistedSnapshot = await this.host.completeReleasePersistence(
          releaseSnapshot,
          reason,
          session,
          terminalPersisted,
        );
      } catch (error) {
        // Removal committed before persistence. Retain its identity and reason
        // while the pending release snapshot is retried by the recovery owner.
        reason.finalizedSnapshot ??= releaseSnapshot;
        this.host.recordFinalizedSessionRelease(session, reason);
        throw toActionableError(error, `Failed to finalize session ${sessionId} release`);
      }
      return this.host.finishCommittedRelease(
        session,
        reason,
        releaseSnapshot,
        persistedSnapshot,
        options,
        pendingCleanup,
      );
    } finally {
      this.host.sessionSlots.unmarkReleasing(session);
    }
  }

  /** Persistence after removal cannot undo a committed release or re-run its listeners. */

  finishCommittedRelease(
    session: Session,
    reason: ReleaseReasonState,
    releaseSnapshot: SessionReleaseSnapshot,
    persistedSnapshot: SessionReleaseSnapshot,
    options: SessionReleaseOptions,
    pendingCleanup: readonly Promise<void>[],
  ): string {
    const { sessionId, deviceId } = releaseSnapshot;
    this.host.recordFinalizedSessionRelease(session, reason);
    if (persistedSnapshot !== releaseSnapshot) {
      // A terminal reason upgraded this release while it persisted. Its cleanup already ran on
      // the first notification, so announce only the reason change (#10825, #11146).
      this.host.notifySessionRelease(persistedSnapshot, { ...options, upgradeOnly: true });
    }
    logger.info(
      pendingCleanup.length > 0
        ? `Released session ${sessionId}; device ${deviceId} remains quarantined until teardown completes`
        : `Released session ${sessionId}, freeing device ${deviceId}`,
    );
    return deviceId;
  }

  /**
   * Remove the released session and quarantine its device until the teardown handed back settles.
   * False when the session's ownership changed meanwhile; its teardown still quarantines the device.
   */

  commitReleaseRemoval(
    sessionId: string,
    session: Session,
    deviceId: string,
    pendingCleanup: readonly Promise<void>[],
  ): boolean {
    const removed = this.host.removeSession(sessionId, session);
    if (pendingCleanup.length > 0) {
      this.host.trackPendingTeardownCleanup(deviceId, pendingCleanup);
    }
    if (!removed) {
      logger.warn(`Skipping release finalization for ${sessionId}: session ownership changed`);
    }
    return removed;
  }

  /** Only a committed handoff retires the old device's saved baselines and serial retries. */

  commitReplacedDeviceTeardown(
    sessionId: string,
    session: Session,
    options: SessionReleaseOptions,
    operation?: SessionReleaseOperation,
  ): void {
    if (!options.deviceIdentityReplaced) {
      return;
    }
    // Retire the replaced serial captured at mark, even if an awaiting rebind published another
    // device. Its generations/retries are independent of the session's new binding (#12063).
    const deviceId = operation?.identityReplacement?.deviceId ?? session.assignedDevice;
    this.host.replacedRestoreGenerations.set(
      deviceId,
      (this.host.replacedRestoreGenerations.get(deviceId) ?? 0) + 1,
    );
    const dropped = new Set<string>();
    if (this.host.stateRestore.clockRestores.targets.has(deviceId)) {
      dropped.add("clock");
    }
    if (
      this.host.stateRestore.abandonedRotations.has(deviceId) ||
      this.host.stateRestore.rotationRestores.targets.has(deviceId)
    ) {
      dropped.add("rotation");
    }
    if (
      this.host.stateRestore.abandonedScreenReaders.has(deviceId) ||
      this.host.stateRestore.screenReaderRestores.targets.has(deviceId)
    ) {
      dropped.add("screen-reader");
    }
    this.host.dropReplacedDeviceRestoreState(session, dropped);
    this.host.retireRestorations(deviceId, "removal");
    if (dropped.size > 0) {
      logger.warn(
        `Dropped restore state for session ${sessionId} on replaced serial ${deviceId}: ${[...dropped].join(", ")}`,
      );
    }
  }

  /** Saved baselines belong to the retired device, never the new occupant of its serial. */

  dropReplacedDeviceRestoreState(session: Session, dropped: Set<string>): void {
    const kinds = [
      ["keepScreenAwake", "keep-awake"],
      ["biometricEnrollment", "biometric"],
      ["networkCondition", "network-condition"],
      ["clock", "clock"],
      ["rotation", "rotation"],
      ["screenReader", "screen-reader"],
    ] as const;
    for (const [key, kind] of kinds) {
      if (session.cacheData[key]) {
        dropped.add(kind);
        delete session.cacheData[key];
      }
    }
  }

  async persistTerminalReleaseWithUpgrade(
    snapshot: SessionReleaseSnapshot,
    reason: ReleaseReasonState,
    session: Session,
  ): Promise<SessionReleaseSnapshot> {
    await this.host.persistTerminalReleaseIfNeeded(snapshot);
    if (reason.value === snapshot.releaseReason) {
      return snapshot;
    }
    const upgradedSnapshot = this.host.withReleaseReason(snapshot, reason.value, session);
    await this.host.persistTerminalReleaseIfNeeded(upgradedSnapshot);
    return upgradedSnapshot;
  }

  /**
   * Persist a terminal release before its session is removed, bounded by
   * {@link SESSION_RELEASE_PERSIST_TIMEOUT_MS} (#10836). At the deadline the in-memory terminal
   * fence (raised before the write) keeps the UUID from routing again, so the release goes on to
   * free the device instead of holding it for as long as the write stays wedged.
   */

  async persistTerminalReleaseWithinDeadline(
    snapshot: SessionReleaseSnapshot,
    reason: ReleaseReasonState,
    session: Session,
  ): Promise<{ snapshot: SessionReleaseSnapshot; persisted: boolean }> {
    try {
      return {
        snapshot: await this.host.persistTerminalReleaseWithUpgrade(snapshot, reason, session),
        persisted: true,
      };
    } catch (error) {
      if (!(error instanceof SessionReleasePersistTimeoutError)) {
        throw error;
      }
      const fenced = this.host.sessionSlots.getTerminalSnapshot(snapshot.sessionId) ?? snapshot;
      if (this.host.volatileTerminalReleaseIntents.get(fenced.sessionId) === fenced.releaseReason) {
        logger.warn(
          `Terminal release of session ${fenced.sessionId} has no crash-safe intent (volatile); ` +
            "freeing its device before the row lands can revive the UUID after a crash",
          error,
        );
      }
      logger.warn(
        `Freeing device ${fenced.deviceId} of session ${fenced.sessionId} before its terminal ` +
          `release row was written (reason=${RELEASE_PERSIST_TIMEOUT_REASON}); the session stays ` +
          "fenced and the next release of it retries the write",
        error,
      );
      return { snapshot: fenced, persisted: false };
    }
  }

  abandonSupersededRelease(
    sessionId: string,
    deviceId: string,
    pendingCleanup: readonly Promise<void>[],
    liftTerminalFence: boolean = false,
  ): null {
    if (liftTerminalFence) {
      this.host.liftTerminalFence(sessionId);
    }
    if (pendingCleanup.length > 0) {
      this.host.trackPendingTeardownCleanup(deviceId, pendingCleanup);
    }
    logger.info(
      `Skipping release of ${sessionId}: a newer identity confirmation superseded the eviction of ${deviceId}`,
    );
    return null;
  }

  /**
   * The final supersede fence declined after the terminal write: lift the fence this release raised
   * and rewrite the live row it terminalized (#11206).
   */

  async abandonReleaseSupersededAfterPersist(
    session: Session,
    releaseSnapshot: SessionReleaseSnapshot,
    pendingCleanup: readonly Promise<void>[],
    liftTerminalFence: boolean,
  ): Promise<null> {
    this.host.abandonSupersededRelease(
      session.sessionId,
      releaseSnapshot.deviceId,
      pendingCleanup,
      liftTerminalFence,
    );
    if (
      liftTerminalFence &&
      releaseSnapshot.terminal &&
      !this.host.superseded.wasRefused(releaseSnapshot)
    ) {
      await this.host.reassertSupersededLiveRow(session, [releaseSnapshot.releaseReason]);
    } else if (liftTerminalFence && this.host.superseded.remembered(session)?.size) {
      // This release's refusal proves only that its own write landed nothing. An earlier
      // superseded release's late row may have deferred its rewrite behind this fence.
      await this.host.reassertSupersededLiveRow(session, []);
    }
    return null;
  }

  upgradeReleaseReason(reason: ReleaseReasonState, candidate: string): void {
    reason.value = resolveReleaseReason(reason.value, candidate);
  }

  createReleaseReasonState(sessionId: string, releaseReason: string): ReleaseReasonState {
    const reason: ReleaseReasonState = { value: releaseReason };
    const terminalReleaseReason =
      this.host.sessionSlots.getTerminalSnapshot(sessionId)?.releaseReason;
    if (terminalReleaseReason) {
      this.host.upgradeReleaseReason(reason, terminalReleaseReason);
    }
    return reason;
  }

  releaseHeartbeatTimeoutMs(releaseReason: string, session: Session): number {
    return releaseReason === "missing-first-heartbeat"
      ? getDefaultPreFirstHeartbeatGraceMs()
      : session.heartbeatTimeoutMs;
  }

  withReleaseReason(
    snapshot: SessionReleaseSnapshot,
    releaseReason: string,
    session?: Session,
  ): SessionReleaseSnapshot {
    const upgraded: SessionReleaseSnapshot = {
      ...snapshot,
      releaseReason,
      terminal: isTerminalReleaseReason(releaseReason),
      heartbeat: {
        ...snapshot.heartbeat,
        timeoutMs: session
          ? this.host.releaseHeartbeatTimeoutMs(releaseReason, session)
          : snapshot.heartbeat.timeoutMs,
      },
    };
    const incarnation = this.host.releaseRowSessions.get(snapshot);
    if (incarnation) {
      this.host.releaseRowSessions.set(upgraded, incarnation);
    }
    this.host.captureReleaseRowGeneration(upgraded, this.host.releaseRowGenerations.get(snapshot));
    this.host.superseded.notePredecessors(upgraded, snapshot);
    return upgraded;
  }

  async completeReleasePersistence(
    snapshot: SessionReleaseSnapshot,
    reason: ReleaseReasonState,
    session: Session,
    terminalPersisted: boolean,
  ): Promise<SessionReleaseSnapshot> {
    if (snapshot.terminal) {
      reason.finalizedSnapshot = snapshot;
      // A timed-out terminal write leaves the row for the next terminal release to persist.
      reason.terminalPersisted = terminalPersisted;
      this.host.sessionSlots.setTerminalReasonState(snapshot.sessionId, reason);
      return snapshot;
    }
    await this.host.persistSessionRelease(snapshot);
    if (reason.value === snapshot.releaseReason) {
      reason.finalizedSnapshot = snapshot;
      return snapshot;
    }
    const upgradedSnapshot = this.host.withReleaseReason(snapshot, reason.value, session);
    reason.finalizedSnapshot = upgradedSnapshot;
    this.host.recordFinalizedSessionRelease(session, reason);
    // The first reason's row, if its write failed, is no longer the one to retry (#11557).
    if (this.host.rowWriter.pendingNonTerminalReleases().get(snapshot.sessionId) === snapshot) {
      this.host.rowWriter.deletePendingNonTerminalRelease(snapshot.sessionId);
    }
    this.host.dropReleaseRetry(snapshot);
    if (upgradedSnapshot.terminal) {
      this.host.sessionSlots.setTerminalReasonState(upgradedSnapshot.sessionId, reason);
      await this.host.persistTerminalReleaseIfNeeded(upgradedSnapshot);
      reason.terminalPersisted = true;
    } else {
      await this.host.persistSessionRelease(upgradedSnapshot);
    }
    return upgradedSnapshot;
  }

  async releaseFinalizedSession(
    reason: ReleaseReasonState,
    releaseReason: string,
  ): Promise<string | null> {
    this.host.upgradeReleaseReason(reason, releaseReason);
    if (reason.lateTerminalRelease) {
      return await reason.lateTerminalRelease;
    }
    const snapshot = reason.finalizedSnapshot;
    if (!snapshot) {
      return null;
    }
    const indexedTerminalReason = this.host.sessionSlots.getTerminalReasonState(snapshot.sessionId);
    if (indexedTerminalReason && indexedTerminalReason !== reason) {
      return null;
    }
    if (snapshot.terminal && reason.terminalPersisted && snapshot.releaseReason === reason.value) {
      return snapshot.deviceId;
    }
    let upgradedSnapshot = this.host.withReleaseReason(snapshot, reason.value);
    reason.finalizedSnapshot = upgradedSnapshot;
    reason.terminalPersisted = false;
    this.host.sessionSlots.setTerminalReasonState(upgradedSnapshot.sessionId, reason);
    const release = (async () => {
      await this.host.persistTerminalReleaseIfNeeded(upgradedSnapshot);
      if (reason.value !== upgradedSnapshot.releaseReason) {
        upgradedSnapshot = this.host.withReleaseReason(upgradedSnapshot, reason.value);
        reason.finalizedSnapshot = upgradedSnapshot;
        this.host.sessionSlots.setTerminalReasonState(upgradedSnapshot.sessionId, reason);
        await this.host.persistTerminalReleaseIfNeeded(upgradedSnapshot);
      }
      reason.terminalPersisted = true;
      // The release's cleanup already ran on the first notification; the device may now belong to
      // the next owner, so announce only the reason change (#10825).
      this.host.notifySessionRelease(upgradedSnapshot, { upgradeOnly: true });
      return upgradedSnapshot.deviceId;
    })();
    reason.lateTerminalRelease = release;
    try {
      return await release;
    } finally {
      reason.lateTerminalRelease = undefined;
    }
  }

  recordFinalizedSessionRelease(session: Session, reason: ReleaseReasonState): void {
    this.host.finalizedSessionReleases.set(session, reason);
    this.host.sessionSlots.recordFinalizedIdentity(session);
  }

  invalidateFinalizedSessionIdentity(sessionId: string): void {
    const identity = this.host.sessionSlots.getFinalizedIdentity(sessionId);
    if (!identity) {
      return;
    }
    const session = identity.deref();
    if (session) {
      this.host.finalizedSessionReleases.delete(session);
    }
    this.host.sessionSlots.deleteFinalizedIdentity(sessionId);
  }
}
