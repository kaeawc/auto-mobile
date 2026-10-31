import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { SessionReleaseSnapshot } from "../sessionManager/releaseTypes";
import {
  DAEMON_STALLED_CODE,
  PROXY_STALLED_CODE,
  runWithoutDaemonLifecycle,
  type LivenessRecovery,
  type TickLatenessClock,
} from "../proxyLivenessRecovery";
import { LifecycleConnectionInFlightError } from "./LifecycleConnectionInFlightError";
import { heartbeatRequestTimeoutMs } from "./heartbeatCadence";
import type { LatestHeartbeatAsk, ProxySessionState } from "./ProxySessionState";
import type { RecoverableReconnectOptions } from "./ConnectionRecovery";

/**
 * Proxy operations shared with routing, reconnects, release handling and recovery:
 * - runLatestBindingHeartbeatTick retains the latest binding's routing and fencing policy.
 * - hasSessionCallInFlight and daemonKeepsSessionInUse share call and daemon idle evidence.
 * - recordHeldSessionTerminalLoss, idleSessionReleaseReason and dropHeldSession share release policy.
 * - withRecoverableReconnect and askSessionHeartbeat share transport and heartbeat wire handling.
 * - recordHeldSessionHeartbeatSuccess and noteLateHeartbeatAck share acknowledgement bookkeeping.
 * - handleHeldSessionHeartbeatError and isMissingHeartbeatAcknowledgement share refusal policy.
 * - heldSessionUuids shares the current binding and held-session selection.
 * - isClosing reads the live mutable shutdown flag.
 */
export interface HeartbeatKeeperPort {
  runLatestBindingHeartbeatTick(): Promise<void>;
  hasSessionCallInFlight(sessionUuid: string): boolean;
  daemonKeepsSessionInUse(sessionUuid: string): boolean;
  recordHeldSessionTerminalLoss(
    sessionUuid: string,
    reason?: string,
    release?: SessionReleaseSnapshot,
    proxyJudged?: true,
  ): void;
  idleSessionReleaseReason(sessionUuid: string): string;
  dropHeldSession(sessionUuid: string, keepHandover?: boolean, keepNotFoundHistory?: boolean): void;
  withRecoverableReconnect<T>(
    operation: () => Promise<T>,
    attemptedSessionUuid?: string,
    allowReleasedSession?: boolean,
    options?: RecoverableReconnectOptions,
  ): Promise<T>;
  askSessionHeartbeat(
    sessionUuid: string,
    claimLivenessOwnership: boolean,
    asked?: LatestHeartbeatAsk,
  ): Promise<void>;
  recordHeldSessionHeartbeatSuccess(sessionUuid: string, claimLivenessOwnership: boolean): void;
  noteLateHeartbeatAck(sessionUuid: string): void;
  handleHeldSessionHeartbeatError(
    sessionUuid: string,
    claimLivenessOwnership: boolean,
    error: unknown,
  ): void;
  isMissingHeartbeatAcknowledgement(error: unknown): boolean;
  heldSessionUuids(): string[];
  isClosing(): boolean;
}

export interface HeartbeatKeeperDependencies {
  timer: Timer;
  state: ProxySessionState;
  tickLateness: TickLatenessClock;
  livenessRecovery: Pick<LivenessRecovery, "begin" | "isRecovering">;
  heartbeatLeashMs: number;
  heartbeatIntervalMs: number;
  boundSessionReplayTtlMs: number;
  port: HeartbeatKeeperPort;
}

export class HeartbeatKeeper {
  constructor(private readonly deps: HeartbeatKeeperDependencies) {}

  async tick(): Promise<void> {
    if (this.deps.tickLateness.note(this.deps.timer.now()) > this.deps.heartbeatLeashMs) {
      this.beginProxyStallRecovery();
    }
    if (this.deps.state.otherHeldSessions.size === 0) {
      await this.deps.port.runLatestBindingHeartbeatTick();
      return;
    }
    // Each held session is isolated: a failure of one never skips the others,
    // and the latest binding's own failure semantics are preserved.
    const [latestBinding] = await Promise.allSettled([
      this.deps.port.runLatestBindingHeartbeatTick(),
      this.heartbeatOtherHeldSessions(),
    ]);
    if (latestBinding.status === "rejected") {
      throw latestBinding.reason;
    }
  }

  /**
   * This proxy's own tick fired later than the lease allows, so its sessions' leases may have
   * lapsed while it could not heartbeat (#10053). Sessions it still heartbeats (and managed
   * sessions) are re-heartbeated with the same owner token: one kept as suspect is restored with
   * the same UUID, one still awaited keeps its window, and one lost is reported in the
   * `proxy_stalled` handover. A stopped unmanaged session waits for a tool call, never stall recovery.
   */
  private beginProxyStallRecovery(): void {
    logger.warn(
      `[DaemonMcpProxy] Heartbeat tick fired more than ${this.deps.heartbeatLeashMs}ms late; re-heartbeating held sessions`,
    );
    for (const sessionUuid of this.deps.port.heldSessionUuids()) {
      if (this.deps.state.notFoundStopped.has(sessionUuid)) {
        continue;
      }
      this.deps.livenessRecovery.begin(sessionUuid, PROXY_STALLED_CODE);
    }
  }

  /** Stop heartbeating held sessions no tool call has named within the idle window (#10657). */
  private evictAbandonedHeldSessions(): void {
    const now = this.deps.timer.now();
    for (const [sessionUuid, held] of [...this.deps.state.otherHeldSessions]) {
      if (
        !this.deps.port.hasSessionCallInFlight(sessionUuid) &&
        now - held.lastUsedAt >= this.deps.boundSessionReplayTtlMs &&
        !this.deps.port.daemonKeepsSessionInUse(sessionUuid)
      ) {
        logger.info(
          `[DaemonMcpProxy] Held session ${sessionUuid} was not used for ${this.deps.boundSessionReplayTtlMs}ms; no longer heartbeating it`,
        );
        this.deps.port.recordHeldSessionTerminalLoss(
          sessionUuid,
          this.deps.port.idleSessionReleaseReason(sessionUuid),
          undefined,
          true,
        );
        this.deps.port.dropHeldSession(sessionUuid);
      }
    }
  }

  private async heartbeatOtherHeldSessions(): Promise<void> {
    this.evictAbandonedHeldSessions();
    await Promise.all(
      [...this.deps.state.otherHeldSessions.keys()].map((sessionUuid) =>
        this.heartbeatHeldSession(sessionUuid),
      ),
    );
  }

  /** Never rejects: a held session's failure is logged and must not stop its siblings. */
  async heartbeatHeldSession(sessionUuid: string): Promise<void> {
    const held = this.deps.state.otherHeldSessions.get(sessionUuid);
    if (!held || this.deps.port.isClosing()) {
      return;
    }
    const claimLivenessOwnership = !held.claimSent;
    try {
      await this.heartbeatWithStallDetection(sessionUuid, async (isCurrent) => {
        // A skipped send proved nothing, so it must not be recorded as a success.
        let sent = false;
        // Fencing the latest binding must not silence its siblings, hence
        // allowReleasedSession. Not-found is not proof of loss here, as on the
        // latest binding's tick: the release notification is authoritative.
        await runWithoutDaemonLifecycle(() =>
          this.deps.port.withRecoverableReconnect(
            // A reconnect retry runs after the hold may have ended: a session handed over while
            // this heartbeat waited on a stalled daemon must not be heartbeated on the daemon
            // that replaced it (#11018), and a dropped one not at all.
            async () => {
              if (this.deps.state.otherHeldSessions.get(sessionUuid) === held) {
                await this.deps.port.askSessionHeartbeat(sessionUuid, claimLivenessOwnership);
                sent = true;
              }
            },
            sessionUuid,
            true,
            { fenceSessionNotFoundOnRetry: false },
          ),
        );
        if (sent && isCurrent()) {
          this.deps.port.recordHeldSessionHeartbeatSuccess(sessionUuid, claimLivenessOwnership);
        } else if (sent && this.deps.state.otherHeldSessions.get(sessionUuid) === held) {
          this.deps.port.noteLateHeartbeatAck(sessionUuid);
        }
      });
    } catch (error) {
      this.deps.port.handleHeldSessionHeartbeatError(sessionUuid, claimLivenessOwnership, error);
    }
  }

  /**
   * Run one session's periodic heartbeat. An ownership refusal, a lost session or any other answer
   * from the daemon is handled by the caller; the absence of an acknowledgement (the heartbeat
   * timed out or the daemon was unreachable) starts bounded recovery for that session (#10053)
   * instead of a time-threshold fence.
   */
  async heartbeatWithStallDetection(
    sessionUuid: string,
    send: (isCurrent: () => boolean) => Promise<void>,
  ): Promise<void> {
    if (this.deps.livenessRecovery.isRecovering(sessionUuid)) {
      return;
    }
    let abandoned = false;
    try {
      await raceWithDeadline(() => send(() => !abandoned), {
        timer: this.deps.timer,
        timeoutMs: heartbeatRequestTimeoutMs(
          this.deps.heartbeatLeashMs,
          this.deps.heartbeatIntervalMs,
        ),
        label: "Bound-session heartbeat",
        onTimeout: () => {
          abandoned = true;
        },
      });
    } catch (error) {
      abandoned = true;
      if (this.deps.port.isClosing()) {
        return;
      }
      if (error instanceof LifecycleConnectionInFlightError) {
        // The heartbeat was never sent: a tool call is establishing the shared connection. That
        // says nothing about the daemon, and the next tick retries on that connection (#10508).
        logger.debug(
          `[DaemonMcpProxy] Heartbeat for session ${sessionUuid} deferred: ${errorMessage(error)}`,
        );
        return;
      }
      if (!this.deps.port.isMissingHeartbeatAcknowledgement(error)) {
        throw error;
      }
      logger.warn(
        `[DaemonMcpProxy] No heartbeat acknowledgement for session ${sessionUuid}: ${errorMessage(error)}; starting recovery`,
      );
      this.deps.livenessRecovery.begin(sessionUuid, DAEMON_STALLED_CODE);
    }
  }
}
