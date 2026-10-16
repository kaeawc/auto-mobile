import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { DAEMON_STALLED_CODE, type DaemonRestartEvidence } from "../proxyLivenessRecovery";
import { daemonInstanceFromError, releaseReasonFromError } from "../types";
import { RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS } from "./notFoundDecision";
import { ackDaemonInstance, isDaemonInstanceChangedError } from "./livenessErrorPredicates";
import type { StallHandoverRecord } from "./ProxySessionState";

/**
 * Proxy operations the stall probe shares with liveness, routing and teardown:
 * - isClosing reads the live mutable shutdown flag.
 * - sendResumeHeartbeat and sendProbeHeartbeat share transport and heartbeat wire handling.
 * - restoreResumedSession, noteDaemonIdleEvidence and endLostSessionHandover share binding and release policy.
 * - isDefinitiveSessionLoss and isDaemonSessionNotFoundError share refusal classification.
 * - startProbeInterval and stopProbeInterval drive the single-flight probe interval that calls back in.
 */
export interface StallProbePort {
  isClosing(): boolean;
  sendResumeHeartbeat(sessionUuid: string): Promise<unknown>;
  sendProbeHeartbeat(
    sessionUuid: string,
    expectedDaemonInstance: string | undefined,
  ): Promise<unknown>;
  restoreResumedSession(sessionUuid: string, restart?: DaemonRestartEvidence): void;
  noteDaemonIdleEvidence(sessionUuid: string, ack: unknown): void;
  endLostSessionHandover(sessionUuid: string, releaseReason?: string, error?: unknown): void;
  isDefinitiveSessionLoss(error: unknown): boolean;
  isDaemonSessionNotFoundError(error: unknown): boolean;
  startProbeInterval(): void;
  stopProbeInterval(): void;
}

export interface StallProbeDependencies {
  timer: Timer;
  stallHandovers: Map<string, StallHandoverRecord>;
  port: StallProbePort;
}

/**
 * The restart a resume acknowledgement reveals (#11018): another daemon process than the one that
 * stalled answered. Undefined when both are the same, or either was never reported.
 */
export function daemonRestartEvidence(
  record: StallHandoverRecord,
  ack: unknown,
): DaemonRestartEvidence | undefined {
  const previousDaemonInstance = record.stalledDaemonInstance;
  const daemonInstance = ackDaemonInstance(ack);
  return previousDaemonInstance !== undefined &&
    daemonInstance !== undefined &&
    daemonInstance !== previousDaemonInstance
    ? { previousDaemonInstance, daemonInstance }
    : undefined;
}

/** Probes handed-over sessions after a daemon stall so they resume or reclaim themselves (#10989). */
export class StallProbe {
  private readonly timer: Timer;
  private readonly stallHandovers: Map<string, StallHandoverRecord>;
  private readonly port: StallProbePort;

  constructor(deps: StallProbeDependencies) {
    this.timer = deps.timer;
    this.stallHandovers = deps.stallHandovers;
    this.port = deps.port;
  }

  hasProbeableStall(): boolean {
    return [...this.stallHandovers.values()].some(
      (record) =>
        record.probeDaemonInstance !== undefined || record.managedReclaimSince !== undefined,
    );
  }

  /**
   * One round of the stall probe (#10989). A daemon that stopped answering may come back by itself
   * (SIGSTOP/SIGCONT, a long GC pause, host sleep) still holding every session: its own stall
   * forgiveness keeps them, but they lapse a lease later unless their owner heartbeats again. Each
   * handed-over session is heartbeated with the same owner token, observation-only and pinned to
   * the daemon process that stalled; the first acknowledgement resumes it. A restarted daemon
   * refuses the pinned heartbeat without changing anything; both plain and managed sessions then
   * reclaim themselves. Keep the heartbeat cadence: a restarted daemon
   * only waits lease + suspect grace for its owner, so reclaim must land within one keeper interval.
   */
  async probeStalledSessions(): Promise<void> {
    const probed = [...this.stallHandovers].filter(
      ([, record]) =>
        record.probeDaemonInstance !== undefined || record.managedReclaimSince !== undefined,
    );
    if (probed.length === 0 || this.port.isClosing()) {
      this.port.stopProbeInterval();
      return;
    }
    await Promise.all(
      probed.map(([sessionUuid, record]) => this.probeStalledSession(sessionUuid, record)),
    );
  }

  private async probeStalledSession(
    sessionUuid: string,
    record: StallHandoverRecord,
  ): Promise<void> {
    const expectedDaemonInstance = record.probeDaemonInstance;
    const reclaiming = record.managedReclaimSince !== undefined;
    let ack: unknown;
    try {
      ack = reclaiming
        ? await this.port.sendResumeHeartbeat(sessionUuid)
        : await this.port.sendProbeHeartbeat(sessionUuid, expectedDaemonInstance);
    } catch (error) {
      await this.handleStallProbeFailure(sessionUuid, record, error);
      return;
    }
    if (this.stallHandovers.get(sessionUuid) !== record || this.port.isClosing()) {
      return;
    }
    logger.info(
      `[DaemonMcpProxy] The daemon answered again and still holds session ${sessionUuid}; resuming it after ${record.handover.code}`,
    );
    this.port.restoreResumedSession(
      sessionUuid,
      reclaiming ? daemonRestartEvidence(record, ack) : undefined,
    );
    this.port.noteDaemonIdleEvidence(sessionUuid, ack);
  }

  private async handleStallProbeFailure(
    sessionUuid: string,
    record: StallHandoverRecord,
    error: unknown,
  ): Promise<void> {
    if (this.stallHandovers.get(sessionUuid) !== record || this.port.isClosing()) {
      return;
    }
    if (isDaemonInstanceChangedError(error)) {
      const wasPinned = record.probeDaemonInstance !== undefined;
      record.probeDaemonInstance = undefined;
      if (wasPinned) {
        record.managedReclaimSince = this.timer.now();
        await this.probeStalledSession(sessionUuid, record);
        return;
      }
      logger.info(
        `[DaemonMcpProxy] The daemon was restarted while session ${sessionUuid} was handed over; ` +
          `no longer probing it, the harness resumes it by naming its sessionUuid`,
      );
      return;
    }
    if (this.port.isDefinitiveSessionLoss(error)) {
      const releaseReason = releaseReasonFromError(error);
      if (
        record.managedReclaimSince !== undefined &&
        this.awaitManagedReclaimNotFound(sessionUuid, record, error)
      ) {
        // The successor may not have rehydrated this session yet; keep the same probe cadence.
        logger.debug(`[DaemonMcpProxy] Session ${sessionUuid} is still awaiting rehydration`);
        return;
      }
      // The daemon answered that the session is gone or owned by another token: the next call
      // that reaches it reports the loss once.
      this.port.endLostSessionHandover(sessionUuid, releaseReason, error);
      return;
    }
    // Expected while the daemon is still stalled; the next probe round asks again.
    logger.debug(
      `[DaemonMcpProxy] Stalled-daemon probe for session ${sessionUuid} got no answer: ${errorMessage(error)}`,
    );
  }

  /** Await only rehydratable not-found answers, within one window per answering process. */
  awaitManagedReclaimNotFound(
    sessionUuid: string,
    record: StallHandoverRecord,
    error: unknown,
  ): boolean {
    const releaseReason = releaseReasonFromError(error);
    if (
      record.managedReclaimSince === undefined ||
      releaseReason !== undefined ||
      record.handover.code !== DAEMON_STALLED_CODE ||
      // Typed ownership losses have different codes and fail this not-found check too.
      !this.port.isDaemonSessionNotFoundError(error)
    ) {
      return false;
    }
    // An unpinned not-found proves the daemon answered but has not rehydrated this execution.
    record.probeDaemonInstance = undefined;
    this.port.startProbeInterval();
    const daemonInstance = daemonInstanceFromError(error);
    const window = record.managedNotFoundWindow;
    if (!window || (daemonInstance !== undefined && daemonInstance !== window.daemonInstance)) {
      record.managedNotFoundWindow = { since: this.timer.now(), daemonInstance };
    }
    return (
      this.timer.now() - record.managedNotFoundWindow!.since <
      RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS
    );
  }
}
