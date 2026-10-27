import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import type { ListChangedKind } from "../listChangedBroadcast";
import {
  DAEMON_STALLED_CODE,
  PROXY_STALLED_CODE,
  type DaemonRestartEvidence,
  type LivenessHandover,
} from "../proxyLivenessRecovery";
import { SESSION_NOT_FOUND_REASON } from "../releaseReasons";
import {
  DAEMON_SESSION_NOT_FOUND_CODE,
  daemonInstanceFromError,
  releaseReasonFromError,
} from "../types";
import { DaemonSessionStalledError } from "./DaemonSessionStalledError";
import type { HeldSessionLosses } from "./HeldSessionLosses";
import {
  isLivenessOwnerConflictError,
  isLivenessOwnershipLostError,
} from "./livenessErrorPredicates";
import type { ProxySessionState, StallHandoverRecord } from "./ProxySessionState";
import { daemonRestartEvidence, type StallProbe } from "./StallProbe";

/**
 * Proxy operations a handover resolution shares with connection, discovery and release policy:
 * - bumpDiscoveryEpoch, invalidateCache and notifyListChanged share discovery scope after a rebind.
 * - syncHeartbeatKeeper and stopStallProbeInterval share keeper and probe lifecycle.
 * - sendResumeHeartbeat shares transport and heartbeat wire handling.
 * - sessionUuidFromArgs, noteDaemonIdleEvidence and currentHandover share routing and handover policy.
 * - reportPendingSessionLoss and notifyLivenessHandoverListeners share loss delivery.
 * - fenceBoundSessionUuid and forgetSessionLivenessState share terminal release policy.
 */
export interface HandoverResolutionPort {
  bumpDiscoveryEpoch(): void;
  invalidateCache(): void;
  notifyListChanged(kind: ListChangedKind): void;
  syncHeartbeatKeeper(): void;
  stopStallProbeInterval(): void;
  sendResumeHeartbeat(sessionUuid: string): Promise<unknown>;
  sessionUuidFromArgs(args: Record<string, unknown>): string | undefined;
  noteDaemonIdleEvidence(sessionUuid: string, ack: unknown): void;
  currentHandover(sessionUuid: string, record: StallHandoverRecord): LivenessHandover;
  reportPendingSessionLoss(args: Record<string, unknown>, terminalRouted?: boolean): void;
  notifyLivenessHandoverListeners(handover: LivenessHandover): void;
  fenceBoundSessionUuid(sessionUuid: string, reason: string): void;
  forgetSessionLivenessState(
    sessionUuid: string,
    keepHandover?: boolean,
    keepNotFoundHistory?: boolean,
  ): void;
}

export interface HandoverResolutionDependencies {
  timer: Timer;
  state: ProxySessionState;
  ownedDeviceSessions: Set<string>;
  heldSessionLosses: Pick<HeldSessionLosses, "pending" | "recordTerminalLoss">;
  stallProbe: Pick<StallProbe, "hasProbeableStall" | "awaitManagedReclaimNotFound">;
  port: HandoverResolutionPort;
}

/**
 * How a session the proxy handed over (a stall, a daemon restart) is resolved: restored when the
 * daemon acknowledges it again, resumed by a call that names it, or ended as lost (#10053, #10989).
 */
export class HandoverResolution {
  private readonly timer: Timer;
  private readonly state: ProxySessionState;
  private readonly ownedDeviceSessions: Set<string>;
  private readonly heldSessionLosses: HandoverResolutionDependencies["heldSessionLosses"];
  private readonly stallProbe: HandoverResolutionDependencies["stallProbe"];
  private readonly port: HandoverResolutionPort;

  constructor(deps: HandoverResolutionDependencies) {
    this.timer = deps.timer;
    this.state = deps.state;
    this.ownedDeviceSessions = deps.ownedDeviceSessions;
    this.heldSessionLosses = deps.heldSessionLosses;
    this.stallProbe = deps.stallProbe;
    this.port = deps.port;
  }

  /**
   * The daemon acknowledged a handed-over session again (#10989): lift its handover and hold it as
   * it was held before, heartbeating it from now on. Its next tool call carries a warning instead
   * of the handover.
   */
  restoreResumedSession(sessionUuid: string, restart?: DaemonRestartEvidence): void {
    const record = this.state.stallHandovers.get(sessionUuid);
    if (!record) {
      return;
    }
    this.state.stallHandovers.delete(sessionUuid);
    this.heldSessionLosses.pending.delete(sessionUuid);
    this.state.plainRestartSessionLosses.delete(sessionUuid);
    this.state.resumedStallNotices.set(sessionUuid, {
      handover: record.handover,
      ...(restart ? { restart } : {}),
    });
    this.state.livenessAcks.set(sessionUuid, this.timer.now());
    const terminal = this.state.terminalBoundSession;
    if (terminal?.sessionUuid === sessionUuid) {
      this.state.terminalBoundSession = undefined;
      this.state.releaseSurfacedFor = undefined;
      if (record.restore.bound && this.state.boundSessionUuid === undefined) {
        this.rebindResumedSession(sessionUuid, record, terminal.fromResultMint);
      }
    }
    if (
      this.state.boundSessionUuid !== sessionUuid &&
      this.state.claimableSessions.has(sessionUuid)
    ) {
      this.state.otherHeldSessions.set(sessionUuid, {
        claimSent: true,
        lastUsedAt: record.restore.lastUsedAt,
      });
    }
    this.resumeHeartbeatKeeper();
    if (!this.stallProbe.hasProbeableStall()) {
      this.port.stopStallProbeInterval();
    }
  }

  /** Make a resumed session the latest binding again, exactly as it was before the handover. */
  private rebindResumedSession(
    sessionUuid: string,
    record: StallHandoverRecord,
    fromResultMint: boolean,
  ): void {
    this.state.boundSessionUuid = sessionUuid;
    this.state.boundSessionUuidAt = record.restore.lastUsedAt;
    this.state.initialSessionBindingConfigured = record.restore.initialBinding;
    this.state.boundSessionFromResultMint = fromResultMint;
    // The resume heartbeat carried this proxy's token and the daemon acknowledged it.
    this.state.livenessOwnershipClaimSent = true;
    this.ownedDeviceSessions.add(sessionUuid);
    // The fence changed the scope discovery runs in; it changes back.
    this.port.bumpDiscoveryEpoch();
    this.port.invalidateCache();
    if (fromResultMint) {
      this.port.notifyListChanged("tools");
    }
  }

  /** Restart the keeper for resumed sessions when the handover idled it (#10989). */
  private resumeHeartbeatKeeper(): void {
    // Idempotent while the keeper runs; restarts it when the handover's stop already cleared it.
    this.port.syncHeartbeatKeeper();
  }

  /**
   * A tool call names a session this proxy gave up on (#10053). It first attempts an
   * observation-only resume with the same token: a daemon that still holds the session (it
   * resumed after its stall, or the harness restarted it) restores it and the call goes ahead,
   * carrying a warning instead of a failure (#10989). A daemon that still does not answer returns
   * the structured handover; a definitive loss queues one structured loss delivery. A call that
   * reaches a handed-over binding without naming it still gets the handover at once: the stall
   * probe resumes that binding as soon as the daemon answers.
   */
  async resumeStalledSessionNamedBy(args: Record<string, unknown>): Promise<void> {
    const sessionUuid = this.port.sessionUuidFromArgs(args);
    const record = sessionUuid ? this.state.stallHandovers.get(sessionUuid) : undefined;
    if (!sessionUuid || !record) {
      return;
    }
    let ack: unknown;
    try {
      ack = await this.port.sendResumeHeartbeat(sessionUuid);
    } catch (error) {
      if (
        this.isDefinitiveSessionLoss(error) &&
        !this.stallProbe.awaitManagedReclaimNotFound(sessionUuid, record, error)
      ) {
        this.endLostSessionHandover(sessionUuid, releaseReasonFromError(error), error);
        this.port.reportPendingSessionLoss(args);
        return;
      }
      logger.warn(
        "[DaemonMcpProxy] Handed-over session was not acknowledged; retaining lifecycle fence",
        error,
      );
      record.delivered = true;
      throw new DaemonSessionStalledError(
        sessionUuid,
        this.port.currentHandover(sessionUuid, record),
      );
    }
    if (this.state.stallHandovers.get(sessionUuid) === record) {
      this.restoreResumedSession(sessionUuid, daemonRestartEvidence(record, ack));
    }
    this.port.noteDaemonIdleEvidence(sessionUuid, ack);
  }

  isDefinitiveSessionLoss(error: unknown): boolean {
    return (
      (error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === DAEMON_SESSION_NOT_FOUND_CODE) ||
      isLivenessOwnershipLostError(error) ||
      isLivenessOwnerConflictError(error)
    );
  }

  endLostSessionHandover(
    sessionUuid: string,
    releaseReason = SESSION_NOT_FOUND_REASON,
    error?: unknown,
  ): void {
    const record = this.state.stallHandovers.get(sessionUuid);
    if (!record) {
      return;
    }
    if (this.endPlainRestartSessionHandover(sessionUuid, record, releaseReason, error)) {
      return;
    }
    // A delivered proxy_stalled already reported this definitive loss. daemon_stalled did not.
    if (record.handover.code !== PROXY_STALLED_CODE || !record.delivered) {
      const loss: LivenessHandover = {
        ...record.handover,
        code: PROXY_STALLED_CODE,
        ...(record.handover.code === DAEMON_STALLED_CODE ? { stalledBy: "daemon" as const } : {}),
        releaseReasons: { [sessionUuid]: releaseReason },
        sessions: record.handover.sessions.filter((session) => session.sessionUuid === sessionUuid),
        lastAcknowledgedHeartbeatAt:
          record.handover.sessions.find((session) => session.sessionUuid === sessionUuid)
            ?.lastAcknowledgedHeartbeatAt ?? record.handover.lastAcknowledgedHeartbeatAt,
        action: "reacquire_lost_sessions",
      };
      this.state.pendingSessionLosses.set(sessionUuid, loss);
      this.heldSessionLosses.recordTerminalLoss(sessionUuid, releaseReason);
      if (record.handover.code === DAEMON_STALLED_CODE) {
        // A daemon stall that ends in a lost session pushes the same liveness notification a
        // proxy stall does, worded as the daemon stall it was (#11028). A proxy_stalled handover
        // was already pushed when it was delivered.
        this.port.notifyLivenessHandoverListeners(loss);
      }
    }
    this.port.forgetSessionLivenessState(sessionUuid);
    if (!this.stallProbe.hasProbeableStall()) {
      this.port.stopStallProbeInterval();
    }
    this.ownedDeviceSessions.delete(sessionUuid);
    this.state.claimableSessions.delete(sessionUuid);
    this.recordTerminalStallLoss(sessionUuid, releaseReason);
  }

  /** A plain successor's definitive release uses terminal ownership loss, with no stall push. */
  private endPlainRestartSessionHandover(
    sessionUuid: string,
    record: StallHandoverRecord,
    releaseReason: string,
    error: unknown,
  ): boolean {
    const answeringDaemonInstance = daemonInstanceFromError(error);
    const restarted =
      record.managedReclaimSince !== undefined ||
      (answeringDaemonInstance !== undefined &&
        answeringDaemonInstance !== record.stalledDaemonInstance);
    if (!restarted) {
      return false;
    }
    this.state.plainRestartSessionLosses.set(sessionUuid, releaseReason);
    this.heldSessionLosses.recordTerminalLoss(sessionUuid, releaseReason);
    if (this.state.terminalBoundSession?.sessionUuid === sessionUuid) {
      this.port.fenceBoundSessionUuid(sessionUuid, releaseReason);
    }
    this.port.forgetSessionLivenessState(sessionUuid);
    this.ownedDeviceSessions.delete(sessionUuid);
    this.state.claimableSessions.delete(sessionUuid);
    if (!this.stallProbe.hasProbeableStall()) {
      this.port.stopStallProbeInterval();
    }
    return true;
  }

  private recordTerminalStallLoss(sessionUuid: string, releaseReason: string): void {
    const terminal = this.state.terminalBoundSession;
    if (terminal?.sessionUuid !== sessionUuid) {
      return;
    }
    terminal.reason = releaseReason;
  }
}
