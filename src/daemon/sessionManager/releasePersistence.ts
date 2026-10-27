import {
  DeviceSessionRowNotReleasableError,
  DeviceSessionRowNotRewritableError,
  isDeviceRestartReleaseReason,
  type DeviceSessionPersistence,
  type MarkReleasedOptions,
  type UpsertActiveSessionOptions,
} from "../../db/deviceSessionRepository";
import type { DeviceSession } from "../../db/types";
import { toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { type Timer } from "../../utils/SystemTimer";
import { SessionReleasePersistTimeoutError } from "../releaseErrors";
import { releasedRowStatus } from "../releaseReasons";
import {
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  type Session,
  type SessionReleaseSnapshot,
} from "../sessionManager";
import { ForcedStuckRelease } from "../sessionManager/forcedStuckRelease";
import { type ReleaseRowRetry, type SessionRowWriter } from "../sessionRowWriter";
import { deriveSlotTag, isSlotTagBeingRecreated, type LegacyLifecycleView } from "../sessionSlots";
import type { SupersededRowReasserts } from "../supersededRowReasserts";
import { TerminalReleaseGenerationRefusedError } from "../TerminalReleaseGenerationRefusedError";
import { type SessionLifecycleSlots } from "./internalContracts";
import { type TerminalIntentDurability } from "./releaseWrite";

export interface SessionReleasePersistenceHost {
  isTerminalReleaseRetryCurrent(snapshot: SessionReleaseSnapshot): boolean;
  retryTerminalReleaseWrite(entry: ReleaseRowRetry): Promise<void>;
  dropReleaseRetry(snapshot: SessionReleaseSnapshot): void;
  readSessionRow(sessionId: string): Promise<DeviceSession | undefined>;
  readonly sessions: Pick<Map<string, Session>, "get" | "has">;
  readonly superseded: Pick<SupersededRowReasserts, "remembered" | "predecessors" | "noteRefused">;
  readonly daemonSessionId: string | undefined;
  retryRefusedRowWrite<T>(
    error: DeviceSessionRowNotRewritableError | DeviceSessionRowNotReleasableError,
    sessionId: string,
    guard: NonNullable<UpsertActiveSessionOptions["rewriteOverSupersededRelease"]>,
    write: (
      guard: NonNullable<UpsertActiveSessionOptions["rewriteOverSupersededRelease"]>,
    ) => Promise<T>,
    releaseReason?: string,
    releaseOptions?: {
      unlessDaemonShutdown?: boolean;
      resolveRowGeneration?: (row: DeviceSession | undefined) => number | undefined;
      incarnation?: Session;
    },
  ): Promise<T>;
  readonly sessionSlots: Pick<
    SessionLifecycleSlots,
    "hasCreation" | "hasAssignment" | "getTerminalSnapshot" | "setTerminalSnapshot"
  >;
  readonly persistedRowGenerations: Pick<WeakMap<Session, number>, "get">;
  readonly rowWriter: Pick<
    SessionRowWriter,
    | "canIssueRelease"
    | "pendingNonTerminalReleases"
    | "deletePendingNonTerminalRelease"
    | "cancelRetry"
    | "scheduleRetry"
    | "trackDrainWrite"
    | "retryPendingNow"
    | "recordPendingNonTerminalRelease"
  >;
  readonly deviceSessionRepository: Pick<DeviceSessionPersistence, "markReleased">;
  retryNonTerminalRowAfterRelease(snapshot: SessionReleaseSnapshot): Promise<void>;
  retryTerminalRowAfterRelease(sessionId: string): Promise<void>;
  readonly forcedStuckRelease: ForcedStuckRelease;
  readonly restartReleasePersistence: WeakMap<SessionReleaseSnapshot, PromiseWithResolvers<void>>;
  readonly timer: Timer;
  isRecoverablePersistedSession(persisted: DeviceSession | undefined): boolean;
  isRowOwnedByLivePeer(row: DeviceSession): boolean;
  waitOutRecreationOf(sessionId: string): Promise<void>;
  getLegacyLifecycleView(): LegacyLifecycleView<Session>;
  readonly restartRecoveryActivityAt: Pick<Map<string, number>, "delete">;
  recordTerminalReleaseIntent(
    snapshot: SessionReleaseSnapshot,
    early?: boolean,
  ): TerminalIntentDurability;
  persistSessionRelease(
    snapshot: SessionReleaseSnapshot,
    retryPending?: boolean,
    statementConditions?: MarkReleasedOptions,
  ): Promise<boolean>;
}

export class SessionReleasePersistence {
  constructor(private readonly host: SessionReleasePersistenceHost) {}

  /** The row generation a non-terminal release snapshot may overwrite (#11129). */
  readonly releaseRowGenerations = new WeakMap<SessionReleaseSnapshot, number>();

  readonly releaseRowSessions = new WeakMap<SessionReleaseSnapshot, WeakRef<Session>>();

  captureReleaseRowGeneration(
    snapshot: SessionReleaseSnapshot,
    rowGeneration: number | undefined,
  ): void {
    if (rowGeneration !== undefined) {
      this.releaseRowGenerations.set(snapshot, rowGeneration);
    }
  }

  /**
   * A release never replaces a live peer's row or an unrelated terminal reason (#11557).
   * A release also applies only to its captured generation, when known (#11129). A committed
   * terminal release can replace this incarnation's own known superseded terminal reason.
   * A parked non-terminal write also preserves the shutdown handoff of its incarnation.
   */
  releaseWritePrecondition(snapshot: SessionReleaseSnapshot): MarkReleasedOptions {
    // ORCHESTRATOR-CHOSEN: the terminal guard applies only when a generation was captured;
    // strict always would refuse legitimate writes for sessions with no captured generation.
    const expectedRowGeneration = this.releaseRowGenerations.get(snapshot);
    const held = this.host.sessions.get(snapshot.sessionId);
    const supersededReasons = held ? this.host.superseded.remembered(held) : undefined;
    return {
      ...(expectedRowGeneration === undefined ? {} : { expectedRowGeneration }),
      ...(!snapshot.terminal && snapshot.releaseReason !== "daemon-shutdown"
        ? { unlessDaemonShutdown: true }
        : {}),
      unlessTerminalOrOwnedByLivePeer: {
        livePeerDaemonSessionIds: [],
        ownDaemonSessionId: this.host.daemonSessionId,
        reportRefusal: true,
        // A committed release may replace our known superseded release; its own reason must
        // never become another superseded row eligible for a later live rewrite.
        supersededReasons:
          snapshot.terminal && !supersededReasons?.has(snapshot.releaseReason)
            ? [...(supersededReasons ?? []), ...this.host.superseded.predecessors(snapshot)]
            : [],
      },
    };
  }

  private resolveTerminalReleaseWrite(
    snapshot: SessionReleaseSnapshot,
    precondition: MarkReleasedOptions,
    write: (options: MarkReleasedOptions) => Promise<void>,
    error: DeviceSessionRowNotReleasableError,
  ): Promise<void> {
    const guard = precondition.unlessTerminalOrOwnedByLivePeer!;
    return this.host.retryRefusedRowWrite(
      error,
      snapshot.sessionId,
      {
        ...guard,
        supersededReasons: guard.supersededReasons ?? [],
        expectedRowGeneration: precondition.expectedRowGeneration,
      },
      (next) =>
        write({
          ...precondition,
          expectedRowGeneration: next.expectedRowGeneration,
          unlessTerminalOrOwnedByLivePeer: next,
        }),
      snapshot.releaseReason,
      {
        unlessDaemonShutdown: precondition.unlessDaemonShutdown,
        incarnation: this.releaseRowSessions.get(snapshot)?.deref(),
        resolveRowGeneration: (row) => {
          const incarnation = this.releaseRowSessions.get(snapshot)?.deref();
          const held = this.host.sessions.get(snapshot.sessionId);
          // A rewrite/rebind by the SAME Session may advance its own generation during release.
          // Re-evaluate on every miss: only that Session's recorded generation may replace the
          // capture. A different held/pending incarnation (#12515), an untracked generation,
          // or a live peer stays protected by the conditioned statement and refusal classifier.
          const ownAdvance =
            incarnation !== undefined &&
            (!held || held === incarnation) &&
            !this.host.sessionSlots.hasCreation(snapshot.sessionId) &&
            !this.host.sessionSlots.hasAssignment(snapshot.sessionId) &&
            row?.stable_identity_generation !== undefined &&
            this.host.persistedRowGenerations.get(incarnation) === row.stable_identity_generation;
          return ownAdvance ? row!.stable_identity_generation : precondition.expectedRowGeneration;
        },
      },
    );
  }

  releaseRowFallback(
    snapshot: SessionReleaseSnapshot,
    precondition: MarkReleasedOptions,
    issueWrite: (options: MarkReleasedOptions) => Promise<void>,
  ): (error: unknown) => Promise<void> {
    const guard = precondition.unlessTerminalOrOwnedByLivePeer!;
    let refusedWrite: Promise<void> | undefined;
    return (error: unknown) => {
      if (
        !(error instanceof DeviceSessionRowNotReleasableError) ||
        error instanceof TerminalReleaseGenerationRefusedError
      ) {
        throw error;
      }
      if (snapshot.terminal) {
        return (refusedWrite ??= this.resolveTerminalReleaseWrite(
          snapshot,
          precondition,
          issueWrite,
          error,
        ));
      }
      if (guard.ownDaemonSessionId === undefined) {
        throw error;
      }
      // A deadline and the first refusal can settle in the same turn; resume only once.
      return (refusedWrite ??= this.host.retryRefusedRowWrite(
        error,
        snapshot.sessionId,
        {
          ...guard,
          supersededReasons: guard.supersededReasons ?? [],
          expectedRowGeneration: precondition.expectedRowGeneration,
        },
        (next) => issueWrite({ ...precondition, unlessTerminalOrOwnedByLivePeer: next }),
        snapshot.releaseReason,
        { unlessDaemonShutdown: precondition.unlessDaemonShutdown },
      ));
    };
  }

  issueReleaseRow(snapshot: SessionReleaseSnapshot, options: MarkReleasedOptions) {
    // A forced-out rebind can noteLive without lifting this snapshot's terminal fence.
    if (
      this.host.sessionSlots.getTerminalSnapshot(snapshot.sessionId) !== snapshot &&
      !this.host.rowWriter.canIssueRelease(snapshot)
    ) {
      return Promise.reject(new TerminalReleaseGenerationRefusedError(snapshot.sessionId));
    }
    return this.host.deviceSessionRepository.markReleased(
      snapshot.sessionId,
      releasedRowStatus(snapshot.releaseReason),
      snapshot.releasedAtMs,
      snapshot.releaseReason,
      options,
    );
  }

  handleReleaseWriteFailure(
    error: unknown,
    snapshot: SessionReleaseSnapshot,
    retryPending: boolean,
  ): boolean {
    if (error instanceof DeviceSessionRowNotReleasableError) {
      // Expected refusal: this row is not ours to release. Resolve intent, without a retry.
      logger.debug(`[SessionManager] Release row refused for ${snapshot.sessionId}`);
      this.host.superseded.noteRefused(snapshot);
      this.confirmReleaseWrite(snapshot);
      return true;
    }
    logger.warn(
      `[SessionManager] Failed to mark session released (${snapshot.releaseReason}): ${error}`,
    );
    if (!snapshot.terminal && !this.host.sessions.has(snapshot.sessionId)) {
      this.recordPendingNonTerminalRelease(snapshot);
      if (!this.shouldSurfaceReleasePersistenceFailure(snapshot, retryPending)) {
        // The session is gone, its row still reads active, and no caller is told: without a
        // retry a restart would rehydrate it (#11557). Retried like a terminal row, on the
        // same backoff. A failure that is surfaced is its caller's to retry.
        this.trackReleaseDrainWrite(this.host.retryNonTerminalRowAfterRelease(snapshot));
      }
    }
    if (this.shouldSurfaceReleasePersistenceFailure(snapshot, retryPending)) {
      throw toActionableError(
        error,
        `Failed to persist ${snapshot.terminal ? "terminal" : "non-terminal"} release for session ${snapshot.sessionId}`,
      );
    }
    return false;
  }

  trackLateReleaseWrite(write: Promise<void>, snapshot: SessionReleaseSnapshot): void {
    // A release that gave up on this write at its deadline has ended the session (#11799 W5), so
    // when the write lands there is no live row of a superseded release to rewrite.
    const settled = write.then(
      () => {
        this.confirmReleaseWrite(snapshot);
      },
      (error: unknown) => {
        if (error instanceof DeviceSessionRowNotReleasableError) {
          // Expected refusal: no terminal write landed, so no compensating rewrite is owed.
          logger.debug(`[SessionManager] Late release row refused for ${snapshot.sessionId}`);
          this.host.superseded.noteRefused(snapshot);
          this.confirmReleaseWrite(snapshot);
          return;
        }
        logger.warn(`[SessionManager] Late session release write failed: ${errorMessage(error)}`);
        // The row is still active: without a retry a restart would revive the released UUID.
        // The release that gave up on this write at its deadline may not have removed the
        // session yet, and the retry is only for a UUID no session holds: after that release.
        if (snapshot.terminal) {
          this.trackReleaseDrainWrite(this.host.retryTerminalRowAfterRelease(snapshot.sessionId));
        }
      },
    );
    this.trackReleaseDrainWrite(settled);
  }

  /** Lift/resolve in one synchronous turn. Confirm/refusal retains the terminal admission fence. */
  liftTerminalFence(
    uuid: string,
    resolved?: Pick<SessionReleaseSnapshot, "releaseReason">,
    retainFence = false,
    afterDelete?: () => void,
  ): void {
    this.host.forcedStuckRelease.liftTerminalFence(uuid, resolved, retainFence, afterDelete);
  }

  /**
   * A release row landed. A terminal one's journal intent is no longer needed (#10959); a
   * non-terminal one is no longer pending, which also ends its retry (#11557).
   */
  confirmReleaseWrite(snapshot: SessionReleaseSnapshot): void {
    if (snapshot.terminal) {
      this.liftTerminalFence(snapshot.sessionId, snapshot, true);
    } else if (
      this.host.rowWriter.pendingNonTerminalReleases().get(snapshot.sessionId) === snapshot
    ) {
      this.host.rowWriter.deletePendingNonTerminalRelease(snapshot.sessionId);
    }
    this.host.restartReleasePersistence.get(snapshot)?.resolve();
  }

  /** The retry of `snapshot` no longer matters: forget it, and a terminal row's journal intent. */
  dropReleaseRetry(snapshot: SessionReleaseSnapshot): void {
    this.host.rowWriter.cancelRetry(snapshot);
    if (snapshot.terminal) {
      this.liftTerminalFence(snapshot.sessionId, snapshot, true);
    }
  }

  /**
   * Queue another write of a release row, after the next backoff delay: a terminal row (#10959),
   * or the pending non-terminal row of a session that is gone (#11557). A terminal row's retry
   * replaces a non-terminal one's for the same UUID, never the reverse.
   */
  scheduleTerminalReleaseRetry(snapshot: SessionReleaseSnapshot): void {
    this.host.rowWriter.scheduleRetry(snapshot, {
      isStillOwed: () => this.host.isTerminalReleaseRetryCurrent(snapshot),
      drop: () => this.host.dropReleaseRetry(snapshot),
      run: (entry) => this.host.retryTerminalReleaseWrite(entry),
    });
  }

  trackReleaseDrainWrite(write: Promise<void>): void {
    this.host.rowWriter.trackDrainWrite(write);
  }

  /**
   * The retry still matters. A terminal row's: the UUID is still fenced by this snapshot and not
   * being re-created. A non-terminal row's: the release is still pending, which a write that
   * landed, a re-issue of the name that published, and shutdown each end. While the name is being
   * issued again the retry waits ({@link retryTerminalReleaseWrite}): its write is conditioned on
   * the released incarnation's row, and an issue that fails leaves that row to release.
   */
  isTerminalReleaseRetryCurrent(snapshot: SessionReleaseSnapshot): boolean {
    if (!snapshot.terminal) {
      return this.host.rowWriter.pendingNonTerminalReleases().get(snapshot.sessionId) === snapshot;
    }
    const fence = this.host.sessionSlots.getTerminalSnapshot(snapshot.sessionId);
    return (
      fence !== undefined &&
      fence.releaseReason === snapshot.releaseReason &&
      !this.isSessionBeingRecreated(snapshot.sessionId)
    );
  }

  async retryTerminalReleaseWrite(entry: ReleaseRowRetry): Promise<void> {
    const { snapshot } = entry;
    if (!(await this.isReleaseRetryDue(entry))) {
      return;
    }
    try {
      const precondition = await this.prepareRetriedReleaseWrite(entry);
      if (!precondition) {
        return;
      }
      const issueWrite = (options: MarkReleasedOptions) => this.issueReleaseRow(snapshot, options);
      const fallback = this.releaseRowFallback(snapshot, precondition, issueWrite);
      const deadlineNow = () => this.host.timer.monotonicNow?.() ?? this.host.timer.now();
      const startedAtMs = deadlineNow();
      let deadlineExpired = false;
      let write = issueWrite(precondition);
      const deadlineOptions = {
        timer: this.host.timer,
        timeoutMs: SESSION_RELEASE_PERSIST_TIMEOUT_MS,
        unref: true,
        label: "Session release retry",
        timeoutError: () =>
          new SessionReleasePersistTimeoutError(
            snapshot.sessionId,
            snapshot.releaseReason,
            SESSION_RELEASE_PERSIST_TIMEOUT_MS,
          ),
        // The retry's first statement can still refuse after its race has timed out.
        onTimeout: () => {
          deadlineExpired = true;
          void write.catch(fallback).catch((error: unknown) => {
            // The timeout already leaves this write owed to the existing retry backoff.
            logger.debug(
              `[SessionManager] Late release retry failed for ${snapshot.sessionId}`,
              error,
            );
          });
        },
      };
      try {
        await raceWithDeadline(write, deadlineOptions);
      } catch (error) {
        write = fallback(error);
        if (deadlineExpired) {
          // A first refusal can win its race in the turn that also fired the deadline.
          // Its fallback is already observed by onTimeout; it cannot extend the release.
          throw deadlineOptions.timeoutError();
        }
        await raceWithDeadline(write, {
          ...deadlineOptions,
          // The first race clears its timer on rejection; spend only its remaining budget.
          timeoutMs: Math.max(
            0,
            SESSION_RELEASE_PERSIST_TIMEOUT_MS - (deadlineNow() - startedAtMs),
          ),
          // Fallback is already running; the timed-out retry leaves it to settle as before.
          onTimeout: undefined,
        });
      }
    } catch (error) {
      if (error instanceof DeviceSessionRowNotReleasableError) {
        if (await this.wasRetriedReleaseWriteSkipped(entry)) {
          this.scheduleTerminalReleaseRetry(snapshot);
          return;
        }
        // Expected refusal: the winning row is left untouched and this release is no longer owed.
        logger.debug(`[SessionManager] Retried release row refused for ${snapshot.sessionId}`);
        this.host.superseded.noteRefused(snapshot);
        this.confirmReleaseWrite(snapshot);
        this.host.dropReleaseRetry(snapshot);
        return;
      }
      logger.warn(
        `[SessionManager] Retrying the ${snapshot.releaseReason} release write of session ` +
          `${snapshot.sessionId} failed: ${errorMessage(error)}`,
      );
      if (entry.isCurrent()) {
        this.scheduleTerminalReleaseRetry(snapshot);
      }
      return;
    }
    if (await this.wasRetriedReleaseWriteSkipped(entry)) {
      this.scheduleTerminalReleaseRetry(snapshot);
      return;
    }
    this.confirmReleaseWrite(snapshot);
    if (entry.isCurrent()) {
      this.host.rowWriter.cancelRetry(snapshot);
    }
  }

  /**
   * Whether a retried non-terminal write was skipped by its own precondition and is still owed: an
   * issue of the name that failed claimed the row and handed it back while the write was in
   * flight, so the generation it named is gone and the row still reads as a restart would
   * rehydrate it. A read that fails leaves the write counted as landed, as before the read.
   */
  private async wasRetriedReleaseWriteSkipped(entry: ReleaseRowRetry): Promise<boolean> {
    const { snapshot } = entry;
    if (snapshot.terminal || !entry.isCurrent()) {
      return false;
    }
    try {
      const row = await this.host.readSessionRow(snapshot.sessionId);
      return (
        row !== undefined &&
        row.release_reason !== snapshot.releaseReason &&
        entry.isCurrent() &&
        this.host.isRecoverablePersistedSession(row) &&
        !this.host.isRowOwnedByLivePeer(row) &&
        !this.isSessionBeingRecreated(snapshot.sessionId)
      );
    } catch (error) {
      logger.warn(
        `[SessionManager] Failed to read the row of session ${snapshot.sessionId} after ` +
          `retrying its ${snapshot.releaseReason} release: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
  }

  /** The entry is still the UUID's retry and still matters; forgotten when it no longer does. */
  private isReleaseRetryStillOwed(entry: ReleaseRowRetry): boolean {
    const { snapshot } = entry;
    if (!entry.isCurrent()) {
      return false;
    }
    if (!this.host.isTerminalReleaseRetryCurrent(snapshot)) {
      this.host.dropReleaseRetry(snapshot);
      return false;
    }
    return true;
  }

  /**
   * Whether the entry's write is to be issued now. A non-terminal row yields to an issue of the
   * name under way: the row is that issue's to claim. Once it publishes the release is no longer
   * pending; if it fails, the row is still this release's to write, so the retry is armed again
   * (or, in shutdown's drain, which arms none, waits for the issue to end).
   */
  private async isReleaseRetryDue(entry: ReleaseRowRetry): Promise<boolean> {
    const { snapshot } = entry;
    if (!this.isReleaseRetryStillOwed(entry)) {
      return false;
    }
    if (snapshot.terminal || !this.isSessionBeingRecreated(snapshot.sessionId)) {
      return true;
    }
    if (!entry.shutdownAttempted) {
      this.scheduleTerminalReleaseRetry(snapshot);
      return false;
    }
    await this.host.waitOutRecreationOf(snapshot.sessionId);
    return this.isReleaseRetryStillOwed(entry);
  }

  /** The precondition a retried release write carries, resolved undefined once the entry was replaced. */
  private async prepareRetriedReleaseWrite(
    entry: ReleaseRowRetry,
  ): Promise<MarkReleasedOptions | undefined> {
    const { snapshot } = entry;
    // Every release preserves peer/terminal rows and names its captured generation, when known.
    const precondition = await this.retriedReleaseWritePrecondition(snapshot);
    return entry.isCurrent() ? precondition : undefined;
  }

  /**
   * The precondition a retried release write carries. A non-terminal row is still pending because
   * its row reads live or recoverable with no session behind it, and an issue of the name that
   * failed may have claimed that row and handed it back meanwhile, which advances its generation
   * (#11243): the write then names the generation the row has now, while a restart would still
   * rehydrate the row, no live peer owns it and nothing holds or is issuing the UUID. Any other
   * row keeps the captured precondition, which leaves it alone.
   */
  async retriedReleaseWritePrecondition(
    snapshot: SessionReleaseSnapshot,
  ): Promise<MarkReleasedOptions> {
    const captured = this.releaseWritePrecondition(snapshot);
    if (captured.expectedRowGeneration === undefined) {
      return captured;
    }
    const row = await this.host.readSessionRow(snapshot.sessionId);
    if (
      !row ||
      row.stable_identity_generation === undefined ||
      !this.host.isRecoverablePersistedSession(row) ||
      this.host.isRowOwnedByLivePeer(row) ||
      this.isSessionBeingRecreated(snapshot.sessionId)
    ) {
      return captured;
    }
    return { ...captured, expectedRowGeneration: row.stable_identity_generation };
  }

  /** Issue every pending terminal retry now, skipping its backoff, and return the writes. */
  retryPendingTerminalReleasesNow(): Promise<void>[] {
    return this.host.rowWriter.retryPendingNow();
  }

  isSessionBeingRecreated(sessionId: string): boolean {
    return isSlotTagBeingRecreated(deriveSlotTag(this.host.getLegacyLifecycleView(), sessionId));
  }

  private shouldSurfaceReleasePersistenceFailure(
    snapshot: SessionReleaseSnapshot,
    retryPending: boolean,
  ): boolean {
    // Device-disconnected releases are terminal, so the terminal check covers them.
    return (
      snapshot.terminal || retryPending || isDeviceRestartReleaseReason(snapshot.releaseReason)
    );
  }

  recordPendingNonTerminalRelease(snapshot: SessionReleaseSnapshot): void {
    this.host.rowWriter.recordPendingNonTerminalRelease(snapshot);
  }

  /**
   * Raise the terminal fence and record the journal intent, synchronously and without writing the
   * row. A release that commits first (#11799) does this ahead of its final supersede fence, so a
   * declined release lifts the fence and resolves the intent in one turn and has no row to undo.
   */
  fenceTerminalRelease(snapshot: SessionReleaseSnapshot): TerminalIntentDurability {
    this.host.sessionSlots.setTerminalSnapshot(snapshot.sessionId, snapshot);
    this.host.restartRecoveryActivityAt.delete(snapshot.sessionId);
    return this.host.recordTerminalReleaseIntent(snapshot, true);
  }

  async persistTerminalReleaseIfNeeded(snapshot: SessionReleaseSnapshot): Promise<void> {
    if (!snapshot.terminal) {
      return;
    }
    // Fence the UUID before durable persistence. If the write fails, callers
    // must still stop routing tools to a device that is already confirmed
    // lost; a later release retry can persist and complete removal.
    this.host.sessionSlots.setTerminalSnapshot(snapshot.sessionId, snapshot);
    this.host.restartRecoveryActivityAt.delete(snapshot.sessionId);
    await this.host.persistSessionRelease(snapshot);
  }
}
