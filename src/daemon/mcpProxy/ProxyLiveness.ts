import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { DaemonShuttingDownError } from "../DaemonShuttingDownError";
import { DaemonUnavailableError, type DaemonClientLike } from "../client/client";
import { DAEMON_HEARTBEAT_METHOD } from "../wire/constants";
import { BoundSessionHeartbeat } from "../proxy/BoundSessionHeartbeat";
import { HeldSessionHeartbeatOutcomes } from "../proxy/HeldSessionHeartbeatOutcomes";
import { type StallHandoverRecord } from "../proxy/ProxySessionState";
import { heartbeatRequestTimeoutMs } from "../proxy/heartbeatCadence";
import { isLivenessOwnershipLostError } from "../proxy/livenessErrorPredicates";
import {
  DAEMON_STALLED_CODE,
  LivenessRecovery,
  PROXY_STALLED_CODE,
  daemonLifecycleAllowed,
  livenessHandoverMessage,
  livenessRecoveryCallWaitMs,
  runWithoutDaemonLifecycle,
  type LivenessHandover,
  type RecoveryAttemptOutcome,
} from "../proxyLivenessRecovery";
import { SESSION_NOT_FOUND_REASON } from "../releaseReasons";
import { type SessionReleaseSnapshot } from "../sessionManager/releaseTypes";
import { daemonInstanceFromError, releaseReasonFromError } from "../types";
import type { ProxyRuntime } from "./ProxyRuntime";
/** Operations supplied by the proxy's composition root. */
export interface ProxyLivenessPort {
  resetConnection(): Promise<void>;
  ensureConnected(): Promise<void>;
  requireClient(): DaemonClientLike;
  boundSessionHeartbeatParams(
    sessionUuid: string,
    claimLivenessOwnership?: boolean,
    reportIdleRelease?: boolean,
  ): {
    sessionId: string;
    livenessPolicy: string;
    idleTimeoutMs?: number;
    livenessOwnerToken: string;
    claimLivenessOwnership?: true;
    reportIdleRelease?: true;
    reportDaemonInstance?: true;
  };
  noteDaemonIdleEvidence(sessionUuid: string, ack: unknown): void;
  answersOwnershipReestablishment(client: DaemonClientLike | null, sessionUuid: string): boolean;
  recordBoundSessionHeartbeatSuccess(
    ...args: Parameters<BoundSessionHeartbeat["recordBoundSessionHeartbeatSuccess"]>
  ): void;
  recordHeldSessionHeartbeatSuccess(
    ...args: Parameters<HeldSessionHeartbeatOutcomes["recordHeldSessionHeartbeatSuccess"]>
  ): void;
  fenceBoundSessionUuid(
    sessionUuid: string,
    reason: string,
    release?: SessionReleaseSnapshot,
  ): void;
  dropHeldSession(sessionUuid: string, keepHandover?: boolean, keepNotFoundHistory?: boolean): void;
}

type Runtime = Pick<
  ProxyRuntime,
  | "ackedDaemonInstance"
  | "boundHeartbeat"
  | "boundSessionFenceGate"
  | "boundSessionUuid"
  | "boundSessionUuidAt"
  | "client"
  | "closing"
  | "connecting"
  | "daemonShutdownAnnouncedAt"
  | "daemonShutdownBarrier"
  | "deadSocketClients"
  | "errorClassifier"
  | "handoverResolution"
  | "heartbeatIntervalMs"
  | "heartbeatLeashMs"
  | "heartbeatOutcomes"
  | "initialSessionBindingConfigured"
  | "latestBindingKeeper"
  | "livenessAcks"
  | "livenessHandoverListeners"
  | "livenessOwnershipClaimSent"
  | "livenessRecovery"
  | "livenessRecoveryCallWait"
  | "otherHeldSessions"
  | "proxyHeartbeatKeeper"
  | "recoveryNotFoundOutcomes"
  | "sessionDeviceIds"
  | "stallHandovers"
  | "stallProbe"
  | "stallResumeProbe"
  | "terminalBoundSession"
  | "timer"
  | "toolCallsInFlight"
  | "toolCallsSettled"
>;

/** Liveness operations on a single proxy runtime. */
export class ProxyLiveness {
  constructor(
    private readonly runtime: Runtime,
    private readonly port: ProxyLivenessPort,
  ) {}

  /**
   * Wait for liveness recovery of the sessions this proxy holds, bounded (#10508). Recovery spreads
   * its attempts over the lease, so an unbounded wait wedged every later call on the connection
   * for as long as recovery ran, including the call that would let the daemon resume the session.
   * The bound runs once per stretch of recovery, from the first call that waits on it: once it has
   * passed, later calls go ahead at once instead of each waiting it out again while the same
   * recovery keeps running. A call that goes ahead keeps its connection observation-only while the
   * fence holds, and a handover recorded meanwhile still surfaces from the caller's own checks.
   */
  async waitForLivenessRecovery(signal?: AbortSignal): Promise<void> {
    if (
      !daemonLifecycleAllowed() ||
      !this.runtime.latestBindingKeeper
        .heldSessionUuids()
        .some((uuid) => this.runtime.livenessRecovery.isRecovering(uuid))
    ) {
      return;
    }
    const deadline = this.livenessRecoveryCallDeadline();
    const timeoutMs = deadline - this.runtime.timer.now();
    if (timeoutMs <= 0) {
      // This stretch of recovery already used up its bound on an earlier call; the same recovery
      // is still running, and waiting it out again would wedge every call on the connection.
      logger.debug("[DaemonMcpProxy] Liveness recovery still running; call goes ahead without it");
      return;
    }
    try {
      await raceWithDeadline(this.runtime.livenessRecovery.settled(), {
        timer: this.runtime.timer,
        timeoutMs,
        signal,
        label: "Daemon liveness recovery",
      });
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(
        `[DaemonMcpProxy] Liveness recovery still running after ${timeoutMs}ms; going ahead without it`,
        error,
      );
    }
  }

  /** When calls stop waiting for the current stretch of recovery, fixed by its first waiting call. */
  livenessRecoveryCallDeadline(): number {
    const episode = this.runtime.livenessRecovery.busyEpisode();
    if (this.runtime.livenessRecoveryCallWait?.episode !== episode) {
      this.runtime.livenessRecoveryCallWait = {
        episode,
        deadline:
          this.runtime.timer.now() +
          livenessRecoveryCallWaitMs(
            this.runtime.heartbeatLeashMs,
            this.heartbeatRequestTimeoutMs(),
          ),
      };
    }
    return this.runtime.livenessRecoveryCallWait.deadline;
  }

  throwIfLivenessHandedOver(): void {
    return this.runtime.boundSessionFenceGate.throwIfLivenessHandedOver();
  }

  async listDuringLivenessFence<T>(request: () => Promise<T>, coldList: () => T): Promise<T> {
    if (this.shouldServeLivenessDiscoveryCold()) {
      return coldList();
    }
    try {
      return await runWithoutDaemonLifecycle(request);
    } catch (error) {
      // Discovery is session-independent; an unreachable daemon keeps its existing cold surface.
      logger.debug("[DaemonMcpProxy] Fenced discovery unavailable; serving cold list", error);
      return coldList();
    }
  }

  shouldServeLivenessDiscoveryCold(): boolean {
    return (
      this.hasLivenessLifecycleFence() &&
      (this.runtime.connecting !== null ||
        this.runtime.daemonShutdownBarrier.pending !== null ||
        this.runtime.latestBindingKeeper
          .heldSessionUuids()
          .some((uuid) => this.runtime.livenessRecovery.isRecovering(uuid)))
    );
  }

  hasLivenessLifecycleFence(): boolean {
    return (
      this.runtime.stallHandovers.size > 0 ||
      this.runtime.latestBindingKeeper
        .heldSessionUuids()
        .some((uuid) => this.runtime.livenessRecovery.isRecovering(uuid))
    );
  }

  /**
   * Register a listener told when automatic liveness recovery was exhausted (#10053), so a harness
   * that is idle between tool calls still learns a session was lost. The same structured error is
   * returned on the next tool call for an affected session.
   */
  onLivenessHandover(listener: (handover: LivenessHandover) => void): () => void {
    this.runtime.livenessHandoverListeners.add(listener);
    return () => {
      this.runtime.livenessHandoverListeners.delete(listener);
    };
  }

  runBoundSessionHeartbeatTick(): Promise<void> {
    return this.runtime.proxyHeartbeatKeeper.tick();
  }

  createLivenessRecovery(): LivenessRecovery {
    return new LivenessRecovery({
      timer: this.runtime.timer,
      leaseMs: this.runtime.heartbeatLeashMs,
      requestTimeoutMs: this.heartbeatRequestTimeoutMs(),
      lastAckAt: (sessionUuid) => this.livenessAckedAt(sessionUuid),
      hasAcknowledgedSince: (sessionUuid, sinceMs) =>
        (this.runtime.livenessAcks.get(sessionUuid) ?? Number.NEGATIVE_INFINITY) > sinceMs,
      deviceIdOf: (sessionUuid) => this.runtime.sessionDeviceIds.get(sessionUuid),
      isActive: (sessionUuid) =>
        !this.runtime.closing && this.runtime.latestBindingKeeper.isHeldSession(sessionUuid),
      attempt: (sessionUuid, attemptNumber, _deadlineMs, claimSocketReset) =>
        this.runRecoveryAttempt(sessionUuid, attemptNumber, claimSocketReset),
      onRecovered: ({ sessionUuid, code, attempts, restoredAfterLapse }) => {
        logger.info(
          `[DaemonMcpProxy] Recovered ${code} for session ${sessionUuid} after ${attempts} attempt(s)` +
            (restoredAfterLapse ? "; the daemon held it as suspect and kept the same UUID" : ""),
        );
      },
      onSessionGone: (sessionUuid) => {
        // The same decision as a keeper tick answered not-found: a replacement daemon that has
        // not materialised a persisted session yet says so with no release reason, and the next
        // tool call restores it (#11411).
        const outcome = this.runtime.recoveryNotFoundOutcomes.get(sessionUuid)?.outcome ?? {
          kind: "stopped",
        };
        this.runtime.recoveryNotFoundOutcomes.delete(sessionUuid);
        this.runtime.boundHeartbeat.applyNotFoundOutcome(sessionUuid, outcome);
      },
      onHandover: (handover) => this.deliverLivenessHandover(handover),
    });
  }

  /** When the daemon last acknowledged this session's heartbeat, falling back to when it was bound. */
  livenessAckedAt(sessionUuid: string): number {
    return (
      this.runtime.livenessAcks.get(sessionUuid) ??
      (sessionUuid === this.runtime.boundSessionUuid
        ? this.runtime.boundSessionUuidAt
        : undefined) ??
      this.runtime.timer.now()
    );
  }

  /** How long a heartbeat is given before it counts as unanswered. */
  heartbeatRequestTimeoutMs(): number {
    return heartbeatRequestTimeoutMs(
      this.runtime.heartbeatLeashMs,
      this.runtime.heartbeatIntervalMs,
    );
  }

  /**
   * One recovery attempt: reconnect if needed and re-heartbeat with the same owner token. The
   * connection is observation-only, so an unreachable daemon fails the attempt; this proxy never
   * starts, restarts or stops it.
   */
  async runRecoveryAttempt(
    sessionUuid: string,
    attemptNumber: number,
    claimSocketReset: () => boolean,
  ): Promise<RecoveryAttemptOutcome> {
    const claimLivenessOwnership = this.livenessClaimPending(sessionUuid);
    let attemptedClient: DaemonClientLike | null = null;
    try {
      await runWithoutDaemonLifecycle(async () => {
        if (this.shouldReplaceSocketForRecovery(attemptNumber, claimSocketReset)) {
          await this.port.resetConnection();
        }
        await this.port.ensureConnected();
        attemptedClient = this.port.requireClient();
        const ack = await attemptedClient.callDaemonMethod(
          DAEMON_HEARTBEAT_METHOD,
          this.port.boundSessionHeartbeatParams(sessionUuid, claimLivenessOwnership, true),
        );
        if (this.runtime.latestBindingKeeper.isHeldSession(sessionUuid)) {
          this.port.noteDaemonIdleEvidence(sessionUuid, ack);
        }
      });
    } catch (error) {
      if (error instanceof DaemonShuttingDownError) {
        // The daemon answered, so the socket works: it is draining, not dead, and the tool calls
        // in flight on it still get their answers ({@link drainingToolCalls}).
        if (attemptedClient !== null && attemptedClient === this.runtime.client) {
          this.runtime.daemonShutdownBarrier.arm();
        }
      } else if (attemptedClient && error instanceof DaemonUnavailableError) {
        this.runtime.deadSocketClients.add(attemptedClient);
      }
      return this.classifyRecoveryAttemptError(sessionUuid, attemptNumber, error, attemptedClient);
    }
    this.port.answersOwnershipReestablishment(attemptedClient, sessionUuid);
    this.recordRecoveryAcknowledgement(sessionUuid, claimLivenessOwnership);
    return "acknowledged";
  }

  /**
   * Whether this attempt may replace the daemon socket. It is one connection shared by every
   * session this proxy holds and by tool calls in flight, so replacing it rejects all of their
   * requests. From the second attempt a socket that is open but silent has already failed to carry
   * a heartbeat, so it is replaced, but at most once per recovery episode (not per session) and
   * never beneath a tool call in flight unless the socket is already proven dead by a transport
   * failure, when there is nothing left to lose.
   */
  shouldReplaceSocketForRecovery(attemptNumber: number, claimSocketReset: () => boolean): boolean {
    const client = this.runtime.client;
    if (attemptNumber <= 1 || !client) {
      return false;
    }
    if (this.runtime.deadSocketClients.has(client)) {
      return true;
    }
    if ((this.runtime.toolCallsInFlight.get(client) ?? 0) > 0) {
      return false;
    }
    return claimSocketReset();
  }

  /**
   * Count a tool call on `client` while it awaits an answer. The caller gets the call's own
   * promise back, not a wrapper, so tracking adds no scheduling turns to the forwarding path.
   */
  trackToolCallInFlight<T>(client: DaemonClientLike, send: () => Promise<T>): Promise<T> {
    const settle = () => {
      const remaining = Math.max(0, (this.runtime.toolCallsInFlight.get(client) ?? 1) - 1);
      this.runtime.toolCallsInFlight.set(client, remaining);
      if (remaining === 0) {
        this.runtime.toolCallsSettled.get(client)?.resolve();
        this.runtime.toolCallsSettled.delete(client);
      }
    };
    this.runtime.toolCallsInFlight.set(
      client,
      (this.runtime.toolCallsInFlight.get(client) ?? 0) + 1,
    );
    let forwarded: Promise<T>;
    try {
      forwarded = send();
    } catch (error) {
      settle();
      throw error;
    }
    forwarded.then(settle, settle);
    return forwarded;
  }

  classifyRecoveryAttemptError(
    sessionUuid: string,
    attemptNumber: number,
    error: unknown,
    attemptedClient: DaemonClientLike | null,
  ): RecoveryAttemptOutcome {
    if (this.runtime.errorClassifier.isDaemonSessionNotFoundError(error)) {
      // The same decision as any other heartbeat's not-found: an attempt that reached a daemon
      // this proxy just connected to gets that session's first answer on the connection (#11570).
      const releaseReason = releaseReasonFromError(error);
      const outcome = this.runtime.boundHeartbeat.noteNotFoundAnswer(
        sessionUuid,
        attemptedClient,
        releaseReason,
        daemonInstanceFromError(error),
      );
      this.runtime.recoveryNotFoundOutcomes.set(sessionUuid, {
        outcome,
        releaseReason,
      });
      return outcome.kind === "awaited" ? "session-awaited" : "session-gone";
    }
    if (!this.runtime.heartbeatOutcomes.isMissingHeartbeatAcknowledgement(error)) {
      // The daemon answered: the session's next answer on this connection is not its first.
      this.port.answersOwnershipReestablishment(attemptedClient, sessionUuid);
    }
    if (isLivenessOwnershipLostError(error)) {
      // Another token took the session over while this proxy could not heartbeat it.
      return "superseded";
    }
    if (!this.runtime.heartbeatOutcomes.isMissingHeartbeatAcknowledgement(error)) {
      // The daemon answered with a conflict refusal: it is reachable, and the regular tick's
      // own conflict handling takes it from here.
      return "acknowledged";
    }
    logger.warn(
      `[DaemonMcpProxy] Recovery attempt ${attemptNumber} for session ${sessionUuid} failed: ${errorMessage(error)}`,
    );
    return "unreachable";
  }

  livenessClaimPending(sessionUuid: string): boolean {
    if (sessionUuid === this.runtime.boundSessionUuid && !this.runtime.terminalBoundSession) {
      return !this.runtime.livenessOwnershipClaimSent;
    }
    return this.runtime.otherHeldSessions.get(sessionUuid)?.claimSent === false;
  }

  recordRecoveryAcknowledgement(sessionUuid: string, claimLivenessOwnership: boolean): void {
    if (sessionUuid === this.runtime.boundSessionUuid && !this.runtime.terminalBoundSession) {
      this.port.recordBoundSessionHeartbeatSuccess(sessionUuid, claimLivenessOwnership, () => true);
    } else if (this.runtime.otherHeldSessions.has(sessionUuid)) {
      this.port.recordHeldSessionHeartbeatSuccess(sessionUuid, claimLivenessOwnership);
    }
  }

  /**
   * Automatic recovery was exhausted: stop heartbeating the affected sessions, remember the
   * structured error for the next tool call that reaches each of them, and tell the harness now.
   */
  deliverLivenessHandover(handover: LivenessHandover): void {
    if (handover.code === PROXY_STALLED_CODE) {
      // Capture each recovery refusal before fencing forgets its liveness state.
      handover = {
        ...handover,
        releaseReasons: Object.fromEntries(
          handover.sessions.map(({ sessionUuid }) => [
            sessionUuid,
            this.runtime.recoveryNotFoundOutcomes.get(sessionUuid)?.releaseReason ??
              SESSION_NOT_FOUND_REASON,
          ]),
        ),
      };
    }
    if (this.isHandoverAfterCleanDaemonShutdown(handover)) {
      logger.warn(
        `[DaemonMcpProxy] ${handover.code} after a clean daemon shutdown (no daemon has ` +
          `acknowledged a heartbeat since): ${livenessHandoverMessage(handover)}`,
      );
    } else {
      logger.error(`[DaemonMcpProxy] ${handover.code}: ${livenessHandoverMessage(handover)}`);
    }
    for (const { sessionUuid } of handover.sessions) {
      this.runtime.stallHandovers.set(sessionUuid, this.stallHandoverRecord(handover, sessionUuid));
    }
    for (const { sessionUuid } of handover.sessions) {
      if (sessionUuid === this.runtime.boundSessionUuid && !this.runtime.terminalBoundSession) {
        this.port.fenceBoundSessionUuid(sessionUuid, handover.code);
      } else {
        this.port.dropHeldSession(sessionUuid, true);
      }
    }
    if (handover.code === PROXY_STALLED_CODE) {
      // Recovery already received a definitive missing-session or superseded-owner answer.
      for (const { sessionUuid } of handover.sessions) {
        this.runtime.handoverResolution.endLostSessionHandover(
          sessionUuid,
          handover.releaseReasons?.[sessionUuid],
        );
      }
    }
    this.notifyLivenessHandoverListeners(handover);
    if (this.runtime.stallProbe.hasProbeableStall() && !this.runtime.closing) {
      this.runtime.stallResumeProbe.start();
    }
  }

  /**
   * A `daemon_stalled` handover whose sessions were last acknowledged before the daemon announced
   * its own shutdown: nothing has answered since the old daemon said it was going away.
   */
  isHandoverAfterCleanDaemonShutdown(handover: LivenessHandover): boolean {
    return (
      handover.code === DAEMON_STALLED_CODE &&
      this.runtime.daemonShutdownAnnouncedAt !== undefined &&
      handover.lastAcknowledgedHeartbeatAt <= this.runtime.daemonShutdownAnnouncedAt
    );
  }

  notifyLivenessHandoverListeners(handover: LivenessHandover): void {
    for (const listener of this.runtime.livenessHandoverListeners) {
      try {
        listener(handover);
      } catch (error) {
        // Best-effort: a dead client transport must not stop the other listeners or the proxy.
        logger.warn(`[DaemonMcpProxy] liveness handover listener failed: ${error}`);
      }
    }
  }

  /**
   * A handover record for one session. Only `daemon_stalled` is probed, and only when the daemon
   * reported which process it is: a resumed daemon is told from a restarted one by it (#10989).
   */
  stallHandoverRecord(handover: LivenessHandover, sessionUuid: string): StallHandoverRecord {
    const probed =
      handover.code === DAEMON_STALLED_CODE && this.runtime.ackedDaemonInstance !== undefined;
    return {
      handover,
      delivered: false,
      ...(probed ? { probeDaemonInstance: this.runtime.ackedDaemonInstance } : {}),
      ...(this.runtime.ackedDaemonInstance !== undefined
        ? { stalledDaemonInstance: this.runtime.ackedDaemonInstance }
        : {}),
      restore: this.stallRestoreSnapshot(sessionUuid),
    };
  }

  /** Answers keep their named session and those still handed over; listeners keep the snapshot. */
  currentHandover(sessionUuid: string, record: StallHandoverRecord): LivenessHandover {
    const handover = record.handover;
    const sessions = handover.sessions.filter(
      (session) =>
        session.sessionUuid === sessionUuid || this.runtime.stallHandovers.has(session.sessionUuid),
    );
    if (sessions.length === handover.sessions.length) {
      return handover;
    }
    return {
      ...handover,
      sessions,
      lastAcknowledgedHeartbeatAt: Math.max(
        ...sessions.map((session) => session.lastAcknowledgedHeartbeatAt),
      ),
    };
  }

  /** How a session is held right before it is handed over, so a resume restores it as it was. */
  stallRestoreSnapshot(sessionUuid: string): StallHandoverRecord["restore"] {
    const bound =
      sessionUuid === this.runtime.boundSessionUuid && !this.runtime.terminalBoundSession;
    return {
      bound,
      lastUsedAt:
        (bound
          ? this.runtime.boundSessionUuidAt
          : this.runtime.otherHeldSessions.get(sessionUuid)?.lastUsedAt) ??
        this.runtime.timer.now(),
      initialBinding: bound && this.runtime.initialSessionBindingConfigured,
    };
  }

  /** Resume-by-name and managed reclaim use the same unpinned, observation-only owner claim. */
  sendStalledSessionResumeHeartbeat(sessionUuid: string): Promise<unknown> {
    return runWithoutDaemonLifecycle(() =>
      raceWithDeadline(
        async () => {
          await this.port.ensureConnected();
          return this.port
            .requireClient()
            .callDaemonMethod(
              DAEMON_HEARTBEAT_METHOD,
              this.port.boundSessionHeartbeatParams(sessionUuid, true, true),
            );
        },
        {
          timer: this.runtime.timer,
          timeoutMs: this.heartbeatRequestTimeoutMs(),
          label: "Resume handed-over session",
        },
      ),
    );
  }

  reportToolSessionLoss(name: string, args: Record<string, unknown>): void {
    return this.runtime.boundSessionFenceGate.reportToolSessionLoss(name, args);
  }

  reportPendingSessionLoss(args: Record<string, unknown>, terminalRouted = true): void {
    return this.runtime.boundSessionFenceGate.reportPendingSessionLoss(args, terminalRouted);
  }
}
