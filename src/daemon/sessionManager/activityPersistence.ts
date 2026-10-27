import {
  DeviceSessionNotActiveError,
  DeviceSessionRowNotReleasableError,
  DeviceSessionRowNotRewritableError,
  DeviceSessionTerminallyReleasedError,
  type DeviceSessionActivityUpdate,
  type UpsertActiveSessionOptions,
} from "../../db/deviceSessionRepository";
import type { DeviceSession } from "../../db/types";
import { SingleFlight } from "../../utils/cache/SingleFlight";
import { logger } from "../../utils/logger";
import { type SessionReleaseReason } from "../releaseReasons";
import type { ReleaseSessionRequest } from "../releaseSessionRequest";
import { TerminalSessionError } from "../sessionErrors";
import { type Session, type SessionReleaseSnapshot } from "../sessionManager";
import { type SessionRowWriter } from "../sessionRowWriter";
import type { SupersededRowReasserts } from "../supersededRowReasserts";
import {
  activityUpdateKey,
  isTaggedTerminalReleaseReason,
  sessionActivityUpdate,
  type IssuedActivityWrite,
  type SessionLifecycleSlots,
} from "./internalContracts";
import { SessionActivityPersistenceError } from "./SessionActivityPersistenceError";

export interface SessionActivityPersistenceHost {
  readonly rowWriter: Pick<
    SessionRowWriter,
    "upsertLive" | "replaceLiveOwnership" | "recordLiveActivity"
  >;
  readonly daemonSessionId: string | undefined;
  sessionNow(): number;
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
  isAdmittedForAutomation(session: Session): boolean;
  trackReleaseDrainWrite(write: Promise<void>): void;
  guardedRowRewriteOptions(
    supersededReasons: readonly string[],
    expectedRowGeneration?: number,
  ): UpsertActiveSessionOptions;
  isCurrentSession(session: Session): boolean;
  isRebindUnderWay(session: Session): boolean;
  oweSupersededRowReassert(session: Session, supersededReasons: readonly string[]): void;
  readonly sessions: Pick<Map<string, Session>, "get">;
  readonly sessionSlots: Pick<SessionLifecycleSlots, "hasTerminalSnapshot" | "getTerminalSnapshot">;
  restoreNonTerminalRowAfterReassert(session: Session): Promise<void>;
  reassertOwedLiveRowForActivity(session: Session): Promise<boolean>;
  readonly superseded: Pick<SupersededRowReasserts, "isReassertPending" | "isOwedFor">;
  getPersistedTerminalRelease(sessionId: string): Promise<SessionReleaseSnapshot | undefined>;
  cancelExecutionsCutByRelease(
    sessionId: string,
    releaseReason: SessionReleaseReason,
    excludeExecutionId?: string,
  ): boolean;
  releaseSessionForReason(
    sessionId: string,
    releaseReason: string,
    request?: ReleaseSessionRequest,
  ): Promise<string | null>;
}

export class SessionActivityPersistence {
  constructor(private readonly host: SessionActivityPersistenceHost) {}

  /**
   * The newest activity row issued for each session incarnation, until that write fails (#11079).
   * A heartbeat whose persisted fields match it has nothing to write, so steady-state heartbeats
   * do no DB work and a peer daemon holding the write lock cannot stall them.
   */
  private readonly issuedActivityWrites = new WeakMap<Session, IssuedActivityWrite>();

  /**
   * The row generation each session incarnation's latest upsert produced (#11129). A non-terminal
   * release captures it so its write cannot land on a row a later incarnation re-upserted.
   */
  readonly persistedRowGenerations = new WeakMap<Session, number>();

  /** Statements may land before settlement records this incarnation's own generation (#12547). */
  private readonly inFlightOwnRowWrites = new WeakMap<Session, Set<Promise<unknown>>>();

  private readonly activityRowRePersists = new SingleFlight<Session, void>();

  // Intentionally NOT barrier-tracked: this write is `await`ed by its caller
  // (createSession), so it is caller-tied, not fire-and-forget. The DbWriteBarrier
  // (issue #2885) only drains fire-and-forget writers at graceful shutdown; an
  // awaited write is already sequenced by its caller and must not be wrapped in
  // `track()`. Do not "fix" this by adding a barrier — that would be a non-bug fix.
  async persistSession(
    session: Session,
    incarnation: Session,
    upsertOptions?: UpsertActiveSessionOptions,
    upsertSettled?: () => void,
  ): Promise<void> {
    const closeJoinableFlight = () => {
      upsertSettled?.();
      upsertSettled = undefined;
    };
    const write = (options: UpsertActiveSessionOptions | undefined) => {
      const statement = this.host.rowWriter.upsertLive(
        {
          sessionUuid: session.sessionId,
          deviceId: session.assignedDevice,
          stableDeviceId: session.stableDeviceId,
          platform: session.platform,
          source: session.persistenceMetadata?.source ?? "session-manager",
          autolockEnabled: session.persistenceMetadata?.autolockEnabled,
          mcpSessionId: session.persistenceMetadata?.mcpSessionId,
          daemonSessionId:
            this.host.daemonSessionId ?? session.persistenceMetadata?.daemonSessionId,
          createdAtMs: session.createdAt,
          lastUsedAtMs: session.lastUsedAt,
          expiresAtMs: session.expiresAt,
          sessionTimeoutMs: session.sessionTimeoutMs,
          heartbeatTimeoutMs: session.heartbeatTimeoutMs,
          heartbeatTimeoutSource: session.heartbeatTimeoutSource,
          hasReceivedHeartbeat: session.hasReceivedHeartbeat,
          livenessPolicy: session.livenessPolicy,
          preCliHeartbeatTimeoutMs: session.preCliLiveness?.heartbeatTimeoutMs,
          preCliHeartbeatTimeoutSource: session.preCliLiveness?.heartbeatTimeoutSource,
          preCliSessionTimeoutMs: session.preCliLiveness?.sessionTimeoutMs,
        },
        // The retention prune compares release stamps (#11129); converted to wall ms with them.
        this.host.sessionNow(),
        options,
      );
      const ownWrites = this.inFlightOwnRowWrites.get(incarnation) ?? new Set<Promise<unknown>>();
      this.inFlightOwnRowWrites.set(incarnation, ownWrites);
      ownWrites.add(statement);
      const settled = () => {
        ownWrites.delete(statement);
        if (ownWrites.size === 0) {
          this.inFlightOwnRowWrites.delete(incarnation);
        }
        closeJoinableFlight();
      };
      void statement.then((rowGeneration) => {
        // Record before waking terminal releases waiting on this same statement (#12547),
        // even if the later ownership write fails. Retries use this same boundary.
        this.recordPersistedRowGeneration(incarnation, rowGeneration);
        settled();
      }, settled);
      return statement;
    };
    const guard = upsertOptions?.rewriteOverSupersededRelease;
    try {
      await write(upsertOptions);
    } catch (error) {
      if (
        !(error instanceof DeviceSessionRowNotRewritableError) ||
        guard?.ownDaemonSessionId === undefined
      ) {
        throw error;
      }
      await this.host.retryRefusedRowWrite(error, session.sessionId, guard, (next) =>
        write({ ...upsertOptions, rewriteOverSupersededRelease: next }),
      );
    }
    await this.host.rowWriter.replaceLiveOwnership(
      session.sessionId,
      session.livenessOwnerToken ?? null,
    );
  }

  awaitInFlightOwnRowWrites(
    incarnation: Session | undefined,
    row: DeviceSession | undefined,
    expectedRowGeneration: number | undefined,
  ): Promise<void> | undefined {
    if (
      !incarnation ||
      row?.stable_identity_generation === expectedRowGeneration ||
      this.persistedRowGenerations.get(incarnation) === row?.stable_identity_generation
    ) {
      return undefined;
    }
    const writes = this.inFlightOwnRowWrites.get(incarnation);
    if (!writes?.size) {
      return undefined;
    }
    return Promise.allSettled(writes).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          // The originating persistence caller handles rejection; release only waits for settlement.
          logger.debug(
            "[SessionManager] Own row write rejected during terminal release",
            result.reason,
          );
        }
      }
    });
  }

  recordPersistedRowGeneration(incarnation: Session, rowGeneration: number | void): void {
    if (typeof rowGeneration === "number") {
      this.persistedRowGenerations.set(incarnation, rowGeneration);
    }
  }

  // Intentionally NOT barrier-tracked when reached via the awaited path
  // (getOrCreateSession -> `await recordSessionActivity`): that path is caller-tied,
  // not fire-and-forget, so the DbWriteBarrier deliberately does not cover it. The
  // fire-and-forget callers above wrap this in `getBarrier().track(...)`; the awaited
  // caller must not. See #2885 — do not wrap the awaited call in `track()`.
  async recordSessionActivity(session: Session): Promise<void> {
    const update = sessionActivityUpdate(session);
    const issued: IssuedActivityWrite = { key: activityUpdateKey(update) };
    this.issuedActivityWrites.set(session, issued);
    try {
      await this.persistSessionActivity(session, update);
    } catch (error) {
      // Forget a failed write only while it is still the newest one, so a later write that
      // carries the same row is not undone; a stale entry only costs one redundant write.
      if (this.issuedActivityWrites.get(session) === issued) {
        this.issuedActivityWrites.delete(session);
      }
      if (error instanceof TerminalSessionError) {
        // Not a storage failure: the session ended, and the caller gets that typed answer.
        throw error;
      }
      throw new SessionActivityPersistenceError(session.sessionId, error);
    }
  }

  /**
   * Write an activity row. When no active row matched (#11129) while this daemon still holds the
   * session — a peer expired it — re-upsert the whole row so the live session stays recoverable. A
   * terminal row is final, whoever wrote it: the upsert refuses, in its statement, to make such a
   * row active again (#11498), and the refusal ends the session here with the row's release. A
   * session this daemon already released has no row to keep.
   */
  async persistSessionActivity(
    session: Session,
    update: DeviceSessionActivityUpdate,
  ): Promise<void> {
    try {
      await this.host.rowWriter.recordLiveActivity(session.sessionId, update);
      return;
    } catch (error) {
      if (!(error instanceof DeviceSessionNotActiveError)) {
        throw error;
      }
    }
    if (!this.host.isAdmittedForAutomation(session)) {
      // Expected: this daemon's own release retired the row while the write was in flight; the
      // released incarnation has nothing left to persist, and callers detect the release.
      logger.debug(`[SessionManager] Activity for released session ${session.sessionId} skipped`);
      return;
    }
    logger.warn(
      `[SessionManager] Session ${session.sessionId} is live but its row is not active; ` +
        "re-persisting it",
    );
    const repair = this.rePersistSessionActivity(session);
    this.host.trackReleaseDrainWrite(
      repair.then(
        () => {},
        () => {
          // The activity caller observes the failure; the drain only waits for its writes.
          logger.debug(`[SessionManager] Activity repair settled for ${session.sessionId}`);
        },
      ),
    );
    await repair;
  }

  private async rePersistSessionActivity(session: Session): Promise<void> {
    try {
      // No read decides this: a terminal release can land after any read, and while the upsert
      // awaits its retention prune (this daemon's own release included).
      const writtenDevice = session.assignedDevice;
      await this.activityRowRePersists.run(session, () =>
        this.persistSession(
          session,
          session,
          {
            unlessTerminal: true,
            rewriteOverSupersededRelease: {
              ...this.host.guardedRowRewriteOptions([], this.persistedRowGenerations.get(session))
                .rewriteOverSupersededRelease!,
              unlessReleased: true,
            },
          },
          () => this.activityRowRePersists.delete(session),
        ),
      );
      if (
        this.host.isCurrentSession(session) &&
        (this.host.isRebindUnderWay(session) || session.assignedDevice !== writtenDevice)
      ) {
        // A rebind began while the write was in flight, so the write may have landed over the
        // rebind's row with the binding from before it: owe the row for the binding now held.
        this.host.oweSupersededRowReassert(session, []);
      } else if (
        this.host.sessions.get(session.sessionId) !== session &&
        !this.host.sessionSlots.hasTerminalSnapshot(session.sessionId)
      ) {
        // A non-terminal release removed the session while the write was in flight, as it can
        // under a rewrite: the row it left active is released again.
        this.host.trackReleaseDrainWrite(this.host.restoreNonTerminalRowAfterReassert(session));
      }
    } catch (error) {
      if (
        !(error instanceof DeviceSessionTerminallyReleasedError) &&
        !(error instanceof DeviceSessionRowNotRewritableError)
      ) {
        throw error;
      }
      await this.handleActivityRowRefusal(session, error);
    }
  }

  private async handleActivityRowRefusal(
    session: Session,
    error: DeviceSessionRowNotRewritableError | DeviceSessionTerminallyReleasedError,
  ): Promise<void> {
    if (!this.host.isCurrentSession(session)) {
      const terminal = this.host.sessionSlots.getTerminalSnapshot(session.sessionId);
      if (terminal) {
        throw new TerminalSessionError(session.sessionId, terminal);
      }
      // The old incarnation is retired: neither a retry nor a release of its replacement is owed.
      logger.debug(`[SessionManager] Superseded activity row refused for ${session.sessionId}`);
      return;
    }
    if (await this.host.reassertOwedLiveRowForActivity(session)) {
      return;
    }
    const terminal = await this.endSessionTerminallyReleasedInRow(session);
    throw terminal instanceof TerminalSessionError ? terminal : error;
  }

  /**
   * The re-persist of a live session found its row terminally released (#11498): the UUID has
   * ended, so the session is not kept in memory behind a row that says otherwise. It is released
   * with the row's own reason (cutting its calls in flight, and returning its device as a lookup
   * that finds an expired session does, because no caller is there to return it), and the typed
   * terminal refusal is resolved for the caller to throw. A session this daemon is already
   * releasing is left to that release.
   */
  async endSessionTerminallyReleasedInRow(session: Session): Promise<Error> {
    const sessionId = session.sessionId;
    if (this.host.superseded.isReassertPending(sessionId)) {
      // The terminal row is this daemon's own superseded release's, about to be rewritten live
      // (#11206): the session lives on, and only this activity write did not persist.
      return new DeviceSessionNotActiveError(sessionId);
    }
    const persistedRelease = await this.host.getPersistedTerminalRelease(sessionId);
    if (
      !persistedRelease ||
      this.host.superseded.isReassertPending(sessionId) ||
      this.host.superseded.isOwedFor(session, persistedRelease.releaseReason)
    ) {
      // The refused row is gone or unreadable (pruned, or a store without lookup), or is being
      // rewritten live, or that rewrite failed and is still owed (#11557): there is no release to
      // adopt, and the activity still did not persist.
      return new DeviceSessionNotActiveError(sessionId);
    }
    const releaseReason = persistedRelease.releaseReason;
    if (this.host.isAdmittedForAutomation(session)) {
      logger.warn(
        `[SessionManager] Session ${sessionId} is live but its row was terminally released ` +
          `(${releaseReason}); releasing it`,
      );
      if (isTaggedTerminalReleaseReason(releaseReason)) {
        this.host.cancelExecutionsCutByRelease(sessionId, releaseReason);
      }
      await this.host.releaseSessionForReason(sessionId, releaseReason, {
        allowExpired: true,
        expiryOrigin: "lazy-expiry",
      });
    }
    return new TerminalSessionError(
      sessionId,
      this.host.sessionSlots.getTerminalSnapshot(sessionId) ?? persistedRelease,
    );
  }

  /** Whether the session's persisted activity fields differ from the newest issued write. */
  hasUnissuedActivity(session: Session): boolean {
    const issued = this.issuedActivityWrites.get(session);
    return issued?.key !== activityUpdateKey(sessionActivityUpdate(session));
  }
}
