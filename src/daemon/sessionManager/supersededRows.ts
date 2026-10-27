import {
  DeviceSessionRowNotReleasableError,
  DeviceSessionRowNotRewritableError,
  type MarkReleasedOptions,
  type UpsertActiveSessionOptions,
} from "../../db/deviceSessionRepository";
import type { DeviceSession } from "../../db/types";
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { type Timer } from "../../utils/SystemTimer";
import { isTerminalReleaseReason, outranksReleaseReason } from "../releaseReasons";
import { type Session, type SessionReleaseSnapshot } from "../sessionManager";
import type {
  OwedSupersededRowReassert,
  OwedSupersededRowReassertCallbacks,
  SupersededRowReasserts,
} from "../supersededRowReasserts";
import { type ReleaseReasonState, type SessionLifecycleSlots } from "./internalContracts";

export interface SupersededSessionRowsHost {
  readSessionRow(sessionId: string): Promise<DeviceSession | undefined>;
  readonly superseded: Pick<
    SupersededRowReasserts,
    | "remember"
    | "expectReassert"
    | "settle"
    | "remembered"
    | "noteRowUnderPendingRelease"
    | "owe"
    | "owed"
    | "drop"
    | "defer"
  >;
  isCurrentSession(session: Session): boolean;
  persistSession(
    session: Session,
    incarnation: Session,
    upsertOptions?: UpsertActiveSessionOptions,
    upsertSettled?: () => void,
  ): Promise<void>;
  readonly sessions: Pick<Map<string, Session>, "get" | "has">;
  readonly liveDaemonSessionIds: (() => ReadonlySet<string>) | undefined;
  readonly daemonSessionId: string | undefined;
  awaitInFlightOwnRowWrites(
    incarnation: Session | undefined,
    row: DeviceSession | undefined,
    expectedRowGeneration: number | undefined,
  ): Promise<void> | undefined;
  readonly sessionSlots: Pick<
    SessionLifecycleSlots,
    | "getRebind"
    | "getTerminalSnapshot"
    | "getForcedNonTerminal"
    | "getFinalizedIdentity"
    | "hasTerminalSnapshot"
    | "getReleaseOp"
    | "getAssignment"
    | "getCreation"
    | "isReleasing"
  >;
  trackReleaseDrainWrite(write: Promise<void>): void;
  persistSessionRelease(
    snapshot: SessionReleaseSnapshot,
    retryPending?: boolean,
    statementConditions?: MarkReleasedOptions,
  ): Promise<boolean>;
  isSessionBeingRecreated(sessionId: string): boolean;
  scheduleTerminalReleaseRetry(snapshot: SessionReleaseSnapshot): void;
  readonly persistedRowGenerations: Pick<WeakMap<Session, number>, "get">;
  captureReleaseRowGeneration(
    snapshot: SessionReleaseSnapshot,
    rowGeneration: number | undefined,
  ): void;
  readonly releaseRowGenerations: Pick<WeakMap<SessionReleaseSnapshot, number>, "get">;
  readonly finalizedSessionReleases: Pick<WeakMap<Session, ReleaseReasonState>, "get">;
  recordPendingNonTerminalRelease(snapshot: SessionReleaseSnapshot): void;
  isRowOwnedByLivePeer(row: DeviceSession): boolean;
  readonly timer: Timer;
  readonly supersededRowReassertRetries: OwedSupersededRowReassertCallbacks;
  readPersistedSession(sessionId: string): Promise<DeviceSession | undefined>;
  terminalReleaseFromPersisted(
    sessionId: string,
    persisted: DeviceSession,
  ): SessionReleaseSnapshot | undefined;
}

export class SupersededSessionRows {
  constructor(private readonly host: SupersededSessionRowsHost) {}

  /**
   * A superseded release lifted its terminal fence, but its terminal row may have landed (#11206).
   * Nothing else rewrites a terminal row, so re-upsert the live row, as a rebind does, while this
   * incarnation still holds the UUID unfenced. A failed write stays owed and is retried (#11557).
   * Resolves true when the live row was written.
   */
  async reassertSupersededLiveRow(
    session: Session,
    supersededReasons: readonly string[],
  ): Promise<boolean> {
    supersededReasons = this.host.superseded.remember(session, supersededReasons);
    if (!this.host.isCurrentSession(session)) {
      return false;
    }
    if (this.isRebindUnderWay(session)) {
      // The rebind's row carries a binding this session does not hold yet, and this write could
      // land over it: owed instead, and settled when the rebind's row lands.
      this.oweSupersededRowReassert(session, supersededReasons);
      return false;
    }
    const writtenDevice = session.assignedDevice;
    const settle = this.host.superseded.expectReassert(session.sessionId, supersededReasons);
    try {
      await this.host.persistSession(
        session,
        session,
        this.supersededRowRewriteOptions(supersededReasons),
      );
    } catch (error) {
      logger.warn(
        `[SessionManager] Failed to re-persist live session ${session.sessionId} after its ` +
          `superseded release: ${errorMessage(error)}`,
        error,
      );
      // Owed before the in-flight count ends, so an activity write always sees one of the two.
      // A session that ended during the write is owed nothing, nor is one revived under its UUID.
      if (this.host.sessions.get(session.sessionId) === session) {
        this.oweSupersededRowReassert(session, supersededReasons);
      } else {
        // Unless a non-terminal release ended it: the superseded release's terminal row is then
        // still in place of that release's.
        this.restoreNonTerminalRowOverSupersededReleaseLater(session, supersededReasons);
      }
      return false;
    } finally {
      settle();
    }
    if (
      this.host.isCurrentSession(session) &&
      (this.isRebindUnderWay(session) || session.assignedDevice !== writtenDevice)
    ) {
      // A rebind began while the write was in flight, so the write may have landed over the
      // rebind's row with the binding from before it: still owed, for the binding now held.
      this.oweSupersededRowReassert(session, supersededReasons);
      return false;
    }
    this.host.superseded.settle(session);
    await this.restoreReleasedRowAfterReassert(session);
    return this.host.isCurrentSession(session);
  }

  /** Snapshot the attached liveness provider for the rewrite's statement guard (#11557). */
  private supersededRowRewriteOptions(
    supersededReasons: readonly string[],
    expectedRowGeneration?: number,
  ): UpsertActiveSessionOptions {
    const livePeerDaemonSessionIds = this.rowWriteLivePeerDaemonSessionIds();
    return {
      rewriteOverSupersededRelease: {
        supersededReasons,
        livePeerDaemonSessionIds,
        expectedRowGeneration,
      },
    };
  }

  /** Discovery failure propagates: an empty fallback would silently remove a statement guard. */
  rowWriteLivePeerDaemonSessionIds(): string[] {
    return Array.from(this.host.liveDaemonSessionIds?.() ?? []).filter(
      (id) => id !== this.host.daemonSessionId,
    );
  }

  guardedRowRewriteOptions(
    supersededReasons: readonly string[],
    expectedRowGeneration?: number,
  ): UpsertActiveSessionOptions {
    return {
      rewriteOverSupersededRelease: {
        supersededReasons,
        expectedRowGeneration,
        livePeerDaemonSessionIds: [],
        ownDaemonSessionId: this.host.daemonSessionId,
      },
    };
  }

  /** Only a refused first statement enters here; every subsequent attempt is still conditioned. */
  async retryRefusedRowWrite<T>(
    error: DeviceSessionRowNotRewritableError | DeviceSessionRowNotReleasableError,
    sessionId: string,
    guard: NonNullable<UpsertActiveSessionOptions["rewriteOverSupersededRelease"]>,
    write: (
      guard: NonNullable<UpsertActiveSessionOptions["rewriteOverSupersededRelease"]>,
    ) => Promise<T>,
    releaseReason?: string,
    releaseOptions: {
      unlessDaemonShutdown?: boolean;
      resolveRowGeneration?: (row: DeviceSession | undefined) => number | undefined;
      incarnation?: Session;
    } = {},
  ): Promise<T> {
    const resolveRow = (row: DeviceSession | undefined) => {
      const withGuard = (current: DeviceSession | undefined) => ({
        row: current,
        guard: releaseOptions.resolveRowGeneration
          ? { ...guard, expectedRowGeneration: releaseOptions.resolveRowGeneration(current) }
          : guard,
      });
      const ownWrites =
        releaseOptions.resolveRowGeneration &&
        this.host.awaitInFlightOwnRowWrites(
          releaseOptions.incarnation,
          row,
          guard.expectedRowGeneration,
        );
      // Read first: a statement can settle during that read. The release deadline bounds
      // this wait; re-read afterwards so later generations and peer ownership stay guarded.
      return ownWrites
        ? ownWrites.then(() => this.host.readSessionRow(sessionId)).then(withGuard)
        : withGuard(row);
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const { row, guard: currentGuard } = await resolveRow(
        await this.host.readSessionRow(sessionId),
      );
      if (
        this.rowWritePermanentlyRefused(
          row,
          currentGuard,
          releaseReason,
          releaseOptions.unlessDaemonShutdown,
        )
      ) {
        throw error;
      }
      if (row?.daemon_session_id && row.daemon_session_id !== this.host.daemonSessionId) {
        // Discovery errors propagate as transient failures; an empty fallback could erase a peer.
        return await write({
          ...currentGuard,
          ownDaemonSessionId: undefined,
          livePeerDaemonSessionIds: this.rowWriteLivePeerDaemonSessionIds(),
        });
      }
      if (attempt === 1) {
        break;
      }
      // Expected hand-back race: the read now shows a row the first statement would write.
      logger.debug(`[SessionManager] Retrying writable row after statement miss for ${sessionId}`);
      try {
        return await write(currentGuard);
      } catch (retryError) {
        if (
          !(retryError instanceof DeviceSessionRowNotRewritableError) &&
          !(retryError instanceof DeviceSessionRowNotReleasableError)
        ) {
          throw retryError;
        }
        // Reclassify the second miss; a still-writable row is transient, never a refusal.
        logger.debug(
          `[SessionManager] Reclassifying row write failure for ${sessionId}`,
          retryError,
        );
        error = retryError;
      }
    }
    throw new ActionableError(
      `Session ${sessionId} row stayed writable after two statement misses; retry its write.`,
    );
  }

  private rowWritePermanentlyRefused(
    row: DeviceSession | undefined,
    guard: NonNullable<UpsertActiveSessionOptions["rewriteOverSupersededRelease"]>,
    releaseReason: string | undefined,
    unlessDaemonShutdown: boolean | undefined,
  ): boolean {
    if (!row) {
      return releaseReason !== undefined;
    }
    if (
      guard.expectedRowGeneration !== undefined &&
      row.stable_identity_generation !== guard.expectedRowGeneration
    ) {
      return true;
    }
    if (guard.unlessReleased && row.status === "released") {
      return true;
    }
    const reason = row.release_reason;
    if (!reason) {
      return false;
    }
    if (releaseReason !== undefined && outranksReleaseReason(reason, releaseReason)) {
      return true;
    }
    if (unlessDaemonShutdown && reason === "daemon-shutdown") {
      return true;
    }
    return isTerminalReleaseReason(reason) && !guard.supersededReasons.includes(reason);
  }

  isRebindUnderWay(session: Session): boolean {
    return this.host.sessionSlots.getRebind(session.sessionId)?.session === session;
  }

  /**
   * A release of the session began while the rewrite was in flight, so the rewrite may have landed
   * over that release's row, or have moved the row's generation under its guarded write: write the
   * released row again. A terminal fence is rewritten at once; a failed re-write is retried.
   */
  async restoreReleasedRowAfterReassert(session: Session): Promise<void> {
    const sessionId = session.sessionId;
    const fence = this.host.sessionSlots.getTerminalSnapshot(sessionId);
    if (!fence) {
      if (this.host.sessions.get(sessionId) !== session) {
        // Not awaited: a release that awaits this rewrite must not wait on its own end.
        this.host.trackReleaseDrainWrite(this.restoreNonTerminalRowAfterReassert(session));
      }
      return;
    }
    try {
      await this.host.persistSessionRelease(fence);
    } catch (error) {
      logger.warn(
        `[SessionManager] Failed to re-persist the terminal release of session ` +
          `${sessionId} after a live-row rewrite: ${errorMessage(error)}`,
        error,
      );
      this.host.trackReleaseDrainWrite(this.retryTerminalRowAfterRelease(sessionId));
      return;
    }
    // That release was superseded in turn, and its own rewrite may have landed before this row.
    await this.reassertSupersededLiveRow(session, [fence.releaseReason]);
  }

  /**
   * A terminal row's write failed outside the release that owns it (the re-write after a live-row
   * rewrite, or a write that outlived the release's deadline): hand the row to the terminal
   * release retry (#10959). That retry writes only for a fenced UUID that no session holds, so
   * not before the release that raised the fence has removed the session. Never rejects.
   */
  async retryTerminalRowAfterRelease(sessionId: string): Promise<void> {
    await this.waitOutReleaseOf(sessionId);
    const fence = this.host.sessionSlots.getTerminalSnapshot(sessionId);
    if (!fence) {
      // That release was superseded: it lifted its fence and rewrites the live row itself.
      return;
    }
    if (this.host.isSessionBeingRecreated(sessionId)) {
      logger.warn(
        `[SessionManager] The terminal release of session ${sessionId} is not persisted and ` +
          "is not retried: the session is still held behind its fence",
      );
      return;
    }
    this.host.scheduleTerminalReleaseRetry(fence);
  }

  /**
   * A non-terminal row's write failed: hand the row to the release retry, once the release that
   * issued it has ended. Until then that release may still take another reason and write that
   * row instead, which ends this one's retry. Never rejects.
   */
  async retryNonTerminalRowAfterRelease(snapshot: SessionReleaseSnapshot): Promise<void> {
    await this.waitOutReleaseOf(snapshot.sessionId);
    this.host.scheduleTerminalReleaseRetry(snapshot);
  }

  /**
   * A non-terminal release removed the session while the rewrite was in flight. Its write names
   * the row generation from before the rewrite, so it either was skipped or was overwritten: once
   * that release has ended, issue its write again for the generation the rewrite produced. A
   * failed write stays pending like any non-terminal release's. Never rejects.
   */
  async restoreNonTerminalRowAfterReassert(session: Session): Promise<void> {
    const sessionId = session.sessionId;
    await this.waitOutReleaseOf(sessionId);
    const snapshot = this.releaseThatEnded(session);
    if (!snapshot || snapshot.terminal) {
      // No release ended the session, or one upgraded to terminal wrote its row after the rewrite.
      return;
    }
    const rewrittenGeneration = this.host.persistedRowGenerations.get(session);
    if (rewrittenGeneration === undefined && this.host.isSessionBeingRecreated(sessionId)) {
      // No generation to guard the write with, and the UUID is being issued again: left alone.
      return;
    }
    // Guarded by the rewrite's generation: a row the UUID's next incarnation wrote since is kept.
    // A write of its own: the release's first write, still in flight for the generation before
    // the rewrite, is skipped by its statement, and must not pass for this one having landed.
    const rewritten: SessionReleaseSnapshot = { ...snapshot };
    this.host.captureReleaseRowGeneration(
      rewritten,
      rewrittenGeneration ?? this.host.releaseRowGenerations.get(snapshot),
    );
    try {
      await this.host.persistSessionRelease(rewritten);
    } catch (error) {
      logger.warn(
        `[SessionManager] Failed to re-persist the ${snapshot.releaseReason} release of session ` +
          `${sessionId} after a live-row rewrite: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /** Not awaited by a release: the restore waits for the release under way to end. */
  restoreNonTerminalRowOverSupersededReleaseLater(
    session: Session,
    supersededReasons: readonly string[],
  ): void {
    if (supersededReasons.length > 0) {
      this.host.trackReleaseDrainWrite(
        this.restoreNonTerminalRowOverSupersededRelease(session, supersededReasons),
      );
    }
  }

  /** The release that removed `session`: the one that finalized, or the one forced in its place. */
  private releaseThatEnded(session: Session): SessionReleaseSnapshot | undefined {
    return (
      this.host.finalizedSessionReleases.get(session)?.finalizedSnapshot ??
      this.host.sessionSlots.getForcedNonTerminal(session)
    );
  }

  /**
   * A non-terminal release ended `session` under the terminal row of its own superseded release:
   * that row landed after the release's (the write was parked, #11206), or its rewrite was still
   * owed when the session ended (#11557). No terminal release ended the UUID, yet the row would
   * refuse the name for good and keep a restart from recovering a handed-off session. Only a
   * live-row write replaces a terminal row, so the row is written as the session held it and then
   * released again, for the generation that write produced. Never rejects.
   */
  async restoreNonTerminalRowOverSupersededRelease(
    superseded: Session,
    supersededReasons: readonly string[],
  ): Promise<void> {
    supersededReasons = this.host.superseded.remember(superseded, supersededReasons);
    const sessionId = superseded.sessionId;
    let session = superseded;
    const settle = this.host.superseded.expectReassert(sessionId, supersededReasons);
    try {
      await this.waitOutReleaseOf(sessionId);
      await this.waitOutRecreationOf(sessionId);
      // The name may have been issued and released again since: the row is then written as its
      // last incarnation held it.
      session = this.host.sessionSlots.getFinalizedIdentity(sessionId)?.deref() ?? superseded;
      supersededReasons = [
        ...new Set([...supersededReasons, ...(this.host.superseded.remembered(session) ?? [])]),
      ];
      const ended = this.releaseThatEnded(session);
      if (
        !ended ||
        ended.terminal ||
        this.host.sessionSlots.hasTerminalSnapshot(sessionId) ||
        this.host.sessions.has(sessionId)
      ) {
        // A terminal release ended the UUID after all, or the name was issued again: that
        // incarnation's row replaced the terminal one, or the late write's own rewrite does.
        return;
      }
      try {
        if (!(await this.replaceSupersededReleaseRow(session, supersededReasons))) {
          return;
        }
      } catch (error) {
        logger.warn(
          `[SessionManager] Failed to replace the superseded release's terminal row of session ` +
            `${sessionId}, which a non-terminal release ended: ${errorMessage(error)}`,
          error,
        );
        // Retried with the release's own row, which is written once this one is replaced.
        const pending: SessionReleaseSnapshot = { ...ended };
        this.host.captureReleaseRowGeneration(pending, this.host.releaseRowGenerations.get(ended));
        this.host.superseded.noteRowUnderPendingRelease({
          session,
          reasons: supersededReasons,
          release: pending,
        });
        this.host.recordPendingNonTerminalRelease(pending);
        this.host.scheduleTerminalReleaseRetry(pending);
        return;
      }
    } finally {
      settle();
    }
    await this.restoreNonTerminalRowAfterReassert(session);
  }

  /**
   * Write the row of the ended `session` as it held it, over the terminal row of its superseded
   * release. Resolves false, writing nothing, when the row is no longer that release's, or is
   * another daemon's session by now. Rejects when the read or the write fails.
   */
  async replaceSupersededReleaseRow(
    session: Session,
    supersededReasons: readonly string[],
  ): Promise<boolean> {
    supersededReasons = [
      ...new Set([...supersededReasons, ...(this.host.superseded.remembered(session) ?? [])]),
    ];
    const row = await this.host.readSessionRow(session.sessionId);
    if (
      !row?.release_reason ||
      !supersededReasons.includes(row.release_reason) ||
      this.host.isRowOwnedByLivePeer(row)
    ) {
      return false;
    }
    await this.host.persistSession(
      session,
      session,
      this.supersededRowRewriteOptions(supersededReasons),
    );
    return true;
  }

  /**
   * Resolve once the release in flight for the UUID, if any, has ended or was forced: a forced
   * release has given the session up already and may never settle (#10963). Never rejects.
   */
  async waitOutReleaseOf(sessionId: string): Promise<void> {
    const release = this.host.sessionSlots.getReleaseOp(sessionId);
    if (!release || release.forced) {
      return;
    }
    try {
      // Without a deadline: only the force's signal ends the wait before the release does.
      await raceWithDeadline(release.promise, {
        timer: this.host.timer,
        signal: release.forcedAbort?.signal,
        label: "Session release",
      });
    } catch (error) {
      // The release reports its failure to its own caller, and a force is its own announcement:
      // only the end of the wait matters here.
      logger.debug(
        `[SessionManager] Release of session ${sessionId} failed or was forced while a row ` +
          `write waited on it: ${errorMessage(error)}`,
      );
    }
  }

  /** Resolve once no issue of the UUID is in flight (it published, or failed). Never rejects. */
  async waitOutRecreationOf(sessionId: string): Promise<void> {
    for (;;) {
      const issue =
        this.host.sessionSlots.getAssignment(sessionId) ??
        this.host.sessionSlots.getCreation(sessionId)?.promise;
      if (!issue) {
        return;
      }
      try {
        await issue;
      } catch (error) {
        // The issue reports its failure to its own caller; only its end matters here.
        logger.debug(
          `[SessionManager] Issue of session ${sessionId} failed while a row write waited ` +
            `on it: ${errorMessage(error)}`,
        );
      }
      // The maps are cleared by the issue's own continuation, which may run after this one.
      await Promise.resolve();
      if (
        issue ===
        (this.host.sessionSlots.getAssignment(sessionId) ??
          this.host.sessionSlots.getCreation(sessionId)?.promise)
      ) {
        return;
      }
    }
  }

  /** Resolve once the rebind in flight for this incarnation, if any, has ended. Never rejects. */
  async waitOutRebindOf(session: Session): Promise<void> {
    const rebind = this.host.sessionSlots.getRebind(session.sessionId);
    if (rebind?.session !== session) {
      return;
    }
    try {
      await rebind.promise;
    } catch (error) {
      // The rebind reports its failure to its own caller; only its end matters here.
      logger.debug(
        `[SessionManager] Rebind of session ${session.sessionId} failed while a row write ` +
          `waited on it: ${errorMessage(error)}`,
      );
    }
  }

  /** Record a failed rewrite as owed; the writer's ledger arms its next retry (#11557). */
  oweSupersededRowReassert(session: Session, supersededReasons: readonly string[]): void {
    this.host.superseded.owe(session, supersededReasons, this.host.supersededRowReassertRetries);
  }

  /**
   * Issue an owed rewrite again; resolves true when the live row was written. The entry is dropped
   * when the session ended, was revived as another incarnation or is fenced, and when the row
   * holds a terminal release that is not the superseded one: that row is the UUID's end, which
   * the session's next activity write acts on (#11498). Never rejects.
   */
  async retryOwedSupersededRowReassert(entry: OwedSupersededRowReassert): Promise<boolean> {
    const { session } = entry;
    const sessionId = session.sessionId;
    const isOwed = (): boolean => this.host.superseded.owed(sessionId) === entry;
    if (!isOwed()) {
      return false;
    }
    if (!this.host.isCurrentSession(session)) {
      this.host.superseded.drop(entry);
      return false;
    }
    let persisted: DeviceSession | undefined;
    try {
      persisted = await this.host.readPersistedSession(sessionId);
    } catch (error) {
      logger.warn(
        `[SessionManager] Failed to read the row of live session ${sessionId} before ` +
          `re-persisting it: ${errorMessage(error)}`,
        error,
      );
      this.host.superseded.defer(entry);
      return false;
    }
    if (!isOwed()) {
      return false;
    }
    if (!this.host.isCurrentSession(session)) {
      this.host.superseded.drop(entry);
      return false;
    }
    if (this.supersededRowReassertMustStop(entry, persisted)) {
      // Peer ownership alone does not end the held session; that is an owner decision.
      this.host.superseded.drop(entry);
      return false;
    }
    if (this.host.sessionSlots.isReleasing(session) || this.isRebindUnderWay(session)) {
      // A release is under way: it removes the session (and this entry) unless it is superseded.
      // Or a rebind is: its row carries the new binding, which this session does not hold yet.
      this.host.superseded.defer(entry);
      return false;
    }
    return await this.reassertSupersededLiveRow(session, [...entry.reasons]);
  }

  /** A peer's winning row is left for the activity or ownership path, without more rewrites. */
  private supersededRowReassertMustStop(
    entry: OwedSupersededRowReassert,
    persisted: DeviceSession | undefined,
  ): boolean {
    if (!persisted) {
      return false;
    }
    if (this.host.isRowOwnedByLivePeer(persisted)) {
      logger.warn(
        `[SessionManager] Dropping owed rewrite of session ${entry.session.sessionId}: live peer ` +
          `${persisted.daemon_session_id} owns its row`,
      );
      return true;
    }
    const release = this.host.terminalReleaseFromPersisted(entry.session.sessionId, persisted);
    const reasons = this.host.superseded.remember(entry.session, [...entry.reasons]);
    return release !== undefined && !reasons.includes(release.releaseReason);
  }

  /**
   * An activity write was refused against a terminal row while the session's rewrite is owed with
   * no retry armed (the retries are exhausted): issue the rewrite now. True when it landed; the
   * row then carries this activity.
   */
  async reassertOwedLiveRowForActivity(session: Session): Promise<boolean> {
    const owed = this.host.superseded.owed(session.sessionId);
    if (owed?.session !== session || owed.handle !== undefined) {
      return false;
    }
    return await this.retryOwedSupersededRowReassert(owed);
  }

  /**
   * The drain's one attempt at an owed rewrite. The retry yields to a rebind or release under way
   * and the drain arms no later one, so wait for it first: a rebind that failed still leaves the
   * live row written before the database closes (one that landed settled the entry). The ledger
   * marks `drainAttempted` before this runs.
   */
  async retryOwedSupersededRowReassertDuringDrain(entry: OwedSupersededRowReassert): Promise<void> {
    await this.waitOutRebindOf(entry.session);
    await this.waitOutReleaseOf(entry.session.sessionId);
    await this.retryOwedSupersededRowReassert(entry);
  }
}
