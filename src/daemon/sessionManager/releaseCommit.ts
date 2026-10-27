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
import type { TerminalIntentDurability } from "./releaseWrite";
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
  fenceTerminalRelease(snapshot: SessionReleaseSnapshot): TerminalIntentDurability;
  persistTerminalReleaseWithinDeadline(
    snapshot: SessionReleaseSnapshot,
    reason: ReleaseReasonState,
    session: Session,
    afterCommit?: boolean,
  ): Promise<{ snapshot: SessionReleaseSnapshot; persisted: boolean }>;
  scheduleTerminalReleaseRetry(snapshot: SessionReleaseSnapshot): void;
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
    afterCommit?: boolean,
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

interface FencedRelease {
  snapshot: SessionReleaseSnapshot;
  intent: TerminalIntentDurability | undefined;
  persisted: boolean;
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
      const terminalFenceHeldBefore = this.host.sessionSlots.hasTerminalSnapshot(sessionId);
      const priorFence = this.host.sessionSlots.getTerminalSnapshot(sessionId);
      let releaseSnapshot = this.buildReleaseSnapshot(
        session,
        deviceId,
        reason.value,
        releasedAtMs,
      );

      // A non-terminal release must not yield after freezing its reason: a
      // concurrent terminal release can only upgrade the shared reason while
      // this operation is awaiting teardown above.
      const fencing = this.fenceTerminal(releaseSnapshot, reason, session, enter);
      const fenced = "then" in fencing ? await fencing : fencing;
      releaseSnapshot = fenced.snapshot;
      const terminalIntent = fenced.intent;
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
      // Final fence: evaluated synchronously right before the commit, with no await in between.
      // A terminal fence this release raised is lifted, with its journal intent, so the live
      // session keeps routing; nothing was written for it.
      if (this.declinesAtFinalFence(terminalIntent, shouldCommit)) {
        operation!.commitDeclined = true;
        // A lifted fence is the abandon call's; a fence held before is given back.
        this.undoUncommittedFence(releaseSnapshot, priorFence, terminalIntent, false);
        return this.host.abandonSupersededRelease(
          sessionId,
          deviceId,
          pendingCleanup,
          !terminalFenceHeldBefore,
        );
      }
      const owedReasons = this.host.superseded.reasonsOwedTo(session);
      if (!this.host.commitReleaseRemoval(sessionId, session, deviceId, pendingCleanup)) {
        // Ownership changed: lift only the fence this release raised, never a newer session's.
        this.undoUncommittedFence(releaseSnapshot, priorFence, terminalIntent, true);
        return null;
      }
      this.host.commitReplacedDeviceTeardown(sessionId, session, options, operation);
      this.settleNonTerminalCommit(releaseSnapshot, session, owedReasons);

      // A durable terminal intent frees the device without waiting for the row, which is written
      // now, after the commit, and awaited below.
      const terminalWrite = this.startCommittedTerminalWrite(
        releaseSnapshot,
        reason,
        session,
        terminalIntent,
        enter,
      );
      this.host.notifySessionRelease(releaseSnapshot, options);
      enter("finalize-persist");
      let persistedSnapshot: SessionReleaseSnapshot;
      try {
        // No await for a release without a deferred row: its microtask turns are pinned.
        const written = terminalWrite ? await terminalWrite : undefined;
        const outcome = this.writtenOutcome(written, fenced);
        persistedSnapshot = await this.host.completeReleasePersistence(
          outcome.snapshot,
          reason,
          session,
          outcome.persisted,
        );
        if (outcome.error !== undefined) {
          // The committed release stays committed; the caller learns its row is owed.
          throw outcome.error;
        }
      } catch (error) {
        this.finalizeFailure(error, session, reason, releaseSnapshot);
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

  /**
   * After the commit, a durable terminal intent writes its row now, ahead of announcing the
   * release, and the finalize step awaits it. Synchronous: the turns of the callers are pinned.
   */
  private startCommittedTerminalWrite(
    snapshot: SessionReleaseSnapshot,
    reason: ReleaseReasonState,
    session: Session,
    intent: TerminalIntentDurability | undefined,
    enter: (stage: SessionReleaseStage) => void,
  ): ReturnType<SessionReleaseCommit["persistCommittedTerminalRelease"]> | undefined {
    if (!snapshot.terminal || intent === "volatile") {
      return undefined;
    }
    enter("terminal-persist");
    return this.persistCommittedTerminalRelease(snapshot, reason, session);
  }

  /**
   * The final supersede fence. A volatile terminal release already wrote its row before this
   * point: it has won, and a newer confirmation arriving during that write is too late (#11799 W5,
   * owner decision 2026-10-26).
   */
  private declinesAtFinalFence(
    intent: TerminalIntentDurability | undefined,
    shouldCommit: ReleaseCommitFence | undefined,
  ): boolean {
    return intent !== "volatile" && releaseSuperseded(shouldCommit);
  }

  /** What the post-commit row write (if any) leaves for the finalize step. */
  private writtenOutcome(
    written: { snapshot: SessionReleaseSnapshot; persisted: boolean; error?: unknown } | undefined,
    fenced: FencedRelease,
  ): { snapshot: SessionReleaseSnapshot; persisted: boolean; error?: unknown } {
    return written ?? { snapshot: fenced.snapshot, persisted: fenced.persisted };
  }

  /** A non-terminal commit lifts any terminal fence and replaces the rows owed over superseded releases. */
  private settleNonTerminalCommit(
    snapshot: SessionReleaseSnapshot,
    session: Session,
    owedReasons: readonly string[],
  ): void {
    if (snapshot.terminal) {
      return;
    }
    this.host.forcedStuckRelease.liftTerminalFenceIfPresent(snapshot.sessionId);
    this.host.sessionSlots.deleteTerminalReasonState(snapshot.sessionId);
    // The removal dropped the rewrite owed over a superseded release's terminal row, and
    // this release's own write does not replace a terminal row.
    this.host.restoreNonTerminalRowOverSupersededReleaseLater(session, owedReasons);
  }

  /** Removal committed before persistence: keep its identity and reason for the retry owner. */
  private finalizeFailure(
    error: unknown,
    session: Session,
    reason: ReleaseReasonState,
    snapshot: SessionReleaseSnapshot,
  ): never {
    reason.finalizedSnapshot ??= snapshot;
    this.host.recordFinalizedSessionRelease(session, reason);
    throw toActionableError(error, `Failed to finalize session ${session.sessionId} release`);
  }

  /** The frozen snapshot of a release: its reason, timing and the row it will write. */
  private buildReleaseSnapshot(
    session: Session,
    deviceId: string,
    releaseReason: string,
    releasedAtMs: number,
  ): SessionReleaseSnapshot {
    const { sessionId } = session;
    const releaseSnapshot: SessionReleaseSnapshot = {
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
    return releaseSnapshot;
  }

  /**
   * Fence the UUID and record the journal intent, synchronously. With a durable intent the row
   * follows the commit, so a release the final fence declines has no terminal row to undo (#11799).
   * A volatile intent cannot protect a crash between the device being freed and the row landing,
   * so that release still writes first.
   */
  private fenceTerminal(
    snapshot: SessionReleaseSnapshot,
    reason: ReleaseReasonState,
    session: Session,
    enter: (stage: SessionReleaseStage) => void,
  ): FencedRelease | Promise<FencedRelease> {
    if (!snapshot.terminal) {
      return { snapshot, intent: undefined, persisted: true };
    }
    const intent = this.host.fenceTerminalRelease(snapshot);
    if (intent !== "volatile") {
      return { snapshot, intent, persisted: true };
    }
    enter("terminal-persist");
    // Synchronous up to the row write; the caller awaits it (its microtask turns are pinned).
    return this.host
      .persistTerminalReleaseWithinDeadline(snapshot, reason, session)
      .then((written) => ({ snapshot: written.snapshot, intent, persisted: written.persisted }));
  }

  /** The release did not commit after its fence was raised: give back what it took. */
  private undoUncommittedFence(
    ours: SessionReleaseSnapshot,
    prior: SessionReleaseSnapshot | undefined,
    intent: TerminalIntentDurability | undefined,
    lifted: boolean,
  ): void {
    if (intent !== "durable") {
      return;
    }
    if (prior) {
      this.restorePriorFence(ours, prior);
    } else if (lifted && this.host.sessionSlots.getTerminalSnapshot(ours.sessionId) === ours) {
      this.host.liftTerminalFence(ours.sessionId, ours);
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
    afterCommit = false,
  ): Promise<SessionReleaseSnapshot> {
    await this.host.persistTerminalReleaseIfNeeded(snapshot);
    if (reason.value === snapshot.releaseReason) {
      return snapshot;
    }
    // The session is gone: a mint or re-creation may have lifted the fence while the first row was
    // in flight, and the upgraded write must not raise it again over the next incarnation.
    if (
      afterCommit &&
      this.host.sessionSlots.getTerminalSnapshot(snapshot.sessionId) !== snapshot
    ) {
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
    afterCommit = false,
  ): Promise<{ snapshot: SessionReleaseSnapshot; persisted: boolean }> {
    try {
      return {
        snapshot: await this.host.persistTerminalReleaseWithUpgrade(
          snapshot,
          reason,
          session,
          afterCommit,
        ),
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

  /**
   * Write a committed terminal release's row (#11799). The session is already removed, so a failed
   * write cannot keep it: like the persist deadline it leaves the device freed, the UUID fenced and
   * the row owed to the retry backoff.
   */
  async persistCommittedTerminalRelease(
    snapshot: SessionReleaseSnapshot,
    reason: ReleaseReasonState,
    session: Session,
  ): Promise<{ snapshot: SessionReleaseSnapshot; persisted: boolean; error?: unknown }> {
    try {
      return await this.host.persistTerminalReleaseWithinDeadline(snapshot, reason, session, true);
    } catch (error) {
      const fenced = this.host.sessionSlots.getTerminalSnapshot(snapshot.sessionId) ?? snapshot;
      logger.warn(
        `Terminal release row of committed session ${fenced.sessionId} was not written; ` +
          "the device is freed and the row is retried",
        error,
      );
      this.host.scheduleTerminalReleaseRetry(fenced);
      return { snapshot: fenced, persisted: false, error };
    }
  }

  /**
   * A release that raised a fence over an earlier one and then did not commit gives the earlier
   * fence back: the earlier release's row is the one still owed, and this release wrote none.
   * Its own journal intent is resolved unless it names the same reason as the earlier one.
   */
  private restorePriorFence(
    ours: SessionReleaseSnapshot,
    prior: SessionReleaseSnapshot | undefined,
  ): void {
    if (!prior || this.host.sessionSlots.getTerminalSnapshot(ours.sessionId) !== ours) {
      return;
    }
    if (prior.releaseReason !== ours.releaseReason) {
      this.host.liftTerminalFence(ours.sessionId, ours, true);
    }
    this.host.sessionSlots.setTerminalSnapshot(ours.sessionId, prior);
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
