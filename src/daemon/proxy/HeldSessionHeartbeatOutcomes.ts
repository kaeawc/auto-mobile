import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  advanceOwnerConflictLeash,
  type LivenessRecovery,
  type ReportedOwnerHold,
} from "../proxyLivenessRecovery";
import type { SessionReleaseSnapshot } from "../sessionManager/releaseTypes";
import { DaemonBoundSessionExpiredError } from "./DaemonBoundSessionExpiredError";
import { HeldSessionNotFoundError } from "./HeldSessionNotFoundError";
import {
  isLivenessOwnerConflictError,
  isLivenessOwnershipLostError,
  reportedOwnerHold,
} from "./livenessErrorPredicates";
import type { NotFoundAnswerOutcome } from "./notFoundDecision";
import type { OtherHeldSession } from "./ProxySessionState";

/**
 * Proxy operations the held-session heartbeat outcomes share with binding and release policy:
 * - isClosing reads the live mutable shutdown flag.
 * - isDaemonSessionNotFoundError shares refusal classification.
 * - applyNotFoundOutcome shares the not-found window and stop policy with the latest binding.
 * - recordHeldSessionTerminalLoss and dropHeldSession share terminal release policy.
 */
export interface HeldSessionHeartbeatOutcomesPort {
  isClosing(): boolean;
  isDaemonSessionNotFoundError(error: unknown): boolean;
  applyNotFoundOutcome(sessionUuid: string, outcome: NotFoundAnswerOutcome): void;
  recordHeldSessionTerminalLoss(
    sessionUuid: string,
    reason?: string,
    release?: SessionReleaseSnapshot,
    proxyJudged?: true,
  ): void;
  dropHeldSession(sessionUuid: string): void;
}

export interface HeldSessionHeartbeatOutcomesDependencies {
  timer: Timer;
  otherHeldSessions: Map<string, OtherHeldSession>;
  notFoundWindows: Map<string, unknown>;
  livenessAcks: Map<string, number>;
  livenessConflictLogged: Set<string>;
  livenessRecovery: Pick<LivenessRecovery, "isRecovering">;
  /** How long a refused claim keeps retrying: the other owner's lease plus its grace (#10053). */
  ownershipConflictLeashMs: number;
  port: HeldSessionHeartbeatOutcomesPort;
}

/**
 * What a held session's heartbeat answer means for the proxy's bookkeeping: acknowledgement
 * evidence, owner-conflict retry and give-up, and the refusals that end the heartbeat.
 */
export class HeldSessionHeartbeatOutcomes {
  private readonly timer: Timer;
  private readonly otherHeldSessions: Map<string, OtherHeldSession>;
  private readonly notFoundWindows: Map<string, unknown>;
  private readonly livenessAcks: Map<string, number>;
  private readonly livenessConflictLogged: Set<string>;
  private readonly livenessRecovery: Pick<LivenessRecovery, "isRecovering">;
  private readonly ownershipConflictLeashMs: number;
  private readonly port: HeldSessionHeartbeatOutcomesPort;

  constructor(deps: HeldSessionHeartbeatOutcomesDependencies) {
    this.timer = deps.timer;
    this.otherHeldSessions = deps.otherHeldSessions;
    this.notFoundWindows = deps.notFoundWindows;
    this.livenessAcks = deps.livenessAcks;
    this.livenessConflictLogged = deps.livenessConflictLogged;
    this.livenessRecovery = deps.livenessRecovery;
    this.ownershipConflictLeashMs = deps.ownershipConflictLeashMs;
    this.port = deps.port;
  }

  /**
   * Whether a failed heartbeat means the daemon never answered, as opposed to answering with a
   * refusal (ownership, unknown session, fenced binding) that its own handler deals with.
   */
  isMissingHeartbeatAcknowledgement(error: unknown): boolean {
    if (
      error instanceof DaemonBoundSessionExpiredError ||
      error instanceof HeldSessionNotFoundError ||
      this.port.isDaemonSessionNotFoundError(error)
    ) {
      return false;
    }
    if (isLivenessOwnerConflictError(error)) {
      return false;
    }
    return !isLivenessOwnershipLostError(error);
  }

  /**
   * A heartbeat the keeper had given up on was acknowledged after all (#10973). While the session
   * is being recovered that acknowledgement is liveness evidence: the daemon renewed the lease, so
   * recovery ends instead of handing the session over. Outside recovery it changes nothing.
   */
  noteLateHeartbeatAck(sessionUuid: string): void {
    if (this.livenessRecovery.isRecovering(sessionUuid)) {
      this.livenessAcks.set(sessionUuid, this.timer.now());
    }
  }

  recordHeldSessionHeartbeatSuccess(sessionUuid: string, claimLivenessOwnership: boolean): void {
    const held = this.otherHeldSessions.get(sessionUuid);
    if (held && claimLivenessOwnership) {
      held.claimSent = true;
    }
    if (held) {
      held.conflict = undefined;
    }
    this.notFoundWindows.delete(sessionUuid);
    this.livenessAcks.set(sessionUuid, this.timer.now());
    this.livenessConflictLogged.delete(sessionUuid);
  }

  handleHeldSessionHeartbeatError(
    sessionUuid: string,
    claimLivenessOwnership: boolean,
    error: unknown,
  ): void {
    if (this.port.isClosing()) {
      return;
    }
    if (isLivenessOwnershipLostError(error)) {
      // Same informational outcome as the latest binding: no fencing or re-claim.
      this.recordHeldSessionHeartbeatSuccess(sessionUuid, claimLivenessOwnership);
      return;
    }
    if (error instanceof HeldSessionNotFoundError) {
      // The daemon does not know this session. Unless it is inside its window, drop it once;
      // retrying every tick would only keep asking, and resetting the socket to ask again would
      // hurt its siblings.
      this.port.applyNotFoundOutcome(sessionUuid, error.outcome);
      return;
    }
    if (isLivenessOwnerConflictError(error)) {
      this.handleHeldSessionOwnerConflict(sessionUuid, reportedOwnerHold(error));
      return;
    }
    if (error instanceof DaemonBoundSessionExpiredError) {
      logger.warn(
        `[DaemonMcpProxy] Held session ${sessionUuid} is gone, no longer heartbeating: ${error.message}`,
        error,
      );
      this.port.recordHeldSessionTerminalLoss(sessionUuid, error.reason, error.release);
      this.port.dropHeldSession(sessionUuid);
      return;
    }
    logger.warn(
      `[DaemonMcpProxy] Heartbeat for held session ${sessionUuid} failed: ${errorMessage(error)}`,
      error,
    );
  }

  /**
   * The daemon refused this held session's claim because another token owns it
   * with a live lease (#10050). The claim stays unsent so each tick retries it,
   * which succeeds once that lease lapses. The other owner's session stays refused for
   * its lease plus the suspect grace window (#10051), which the refusal reports, so it is only
   * given up on once that owner keeps renewing past the handoff allowance (#10701): then this
   * proxy cannot own the session and stops heartbeating that session alone; siblings are
   * unaffected.
   */
  private handleHeldSessionOwnerConflict(
    sessionUuid: string,
    hold: ReportedOwnerHold | undefined,
  ): void {
    const held = this.otherHeldSessions.get(sessionUuid);
    if (!held) {
      return;
    }
    const { leash, exhausted } = advanceOwnerConflictLeash(
      held.conflict,
      this.timer.now(),
      hold,
      this.ownershipConflictLeashMs,
    );
    held.conflict = leash;
    if (exhausted) {
      logger.warn(
        `[DaemonMcpProxy] Held session ${sessionUuid} is owned by another live liveness owner; no longer heartbeating it`,
      );
      this.livenessConflictLogged.delete(sessionUuid);
      this.port.recordHeldSessionTerminalLoss(sessionUuid, "liveness-owner-conflict");
      this.port.dropHeldSession(sessionUuid);
      return;
    }
    this.noteLivenessOwnerConflict(sessionUuid);
  }

  noteLivenessOwnerConflict(sessionUuid: string): void {
    if (this.livenessConflictLogged.has(sessionUuid)) {
      return;
    }
    this.livenessConflictLogged.add(sessionUuid);
    logger.warn(
      `[DaemonMcpProxy] Session ${sessionUuid} is owned by another live liveness owner; retrying the claim until its lease expires`,
    );
  }
}
