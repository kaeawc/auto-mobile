import type { Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import {
  UNSETTLED_EXECUTION_VETO_CEILING_MS,
  UnsettledExecutionVeto,
  type SessionExecutionProbeInput,
} from "./unsettledExecutionVeto";
import type { Session } from "./sessionManager";

/**
 * Longest an active control call may keep a session whose owner disconnected (#10663): the same
 * bound the heartbeat monitor applies, from the shared policy in `./unsettledExecutionVeto`.
 */
export const OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS = UNSETTLED_EXECUTION_VETO_CEILING_MS;

/** A release the pool deferred because an in-flight control call vetoed it. */
export interface OwnerDisconnectReleaseDeferral {
  /**
   * When the veto stops holding, on the release's clock (the session clock, #11162); the release
   * is retried then if no call end re-arms it first.
   */
  deferredUntil: number;
}

/**
 * Bounds how long active control calls may veto the owner-disconnect release of a session
 * (#10663). The #5343 "never reap mid-control-call" rule holds while the shared unsettled-execution veto
 * policy allows; past its bound the session is released anyway.
 */
export class OwnerDisconnectExecutionVeto {
  private readonly veto: UnsettledExecutionVeto;

  constructor(
    executions: SessionExecutionProbeInput,
    timer: Timer,
    ceilingMs: number = OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS,
    /** The veto's clock; the daemon passes its session clock (#11162). */
    now?: () => number,
  ) {
    this.veto = new UnsettledExecutionVeto(executions, timer, ceilingMs, now);
  }

  /**
   * The deferral while active executions still keep this session from its owner-disconnect
   * release, or undefined when it may be released now.
   */
  keeps(session: Session): OwnerDisconnectReleaseDeferral | undefined {
    const verdict = this.veto.judge(session);
    if (verdict.kind === "kept") {
      if (verdict.firstKept) {
        logger.info(
          `[OwnerDisconnectRelease] Kept session ${session.sessionId} after its owner disconnected: ` +
            `executions are still active; retrying the release once they end`,
        );
      }
      return { deferredUntil: verdict.until };
    }
    if (verdict.kind === "expired") {
      this.veto.forget(session);
      logger.warn(
        `[OwnerDisconnectRelease] Session ${session.sessionId} was kept for ${verdict.vetoedMs}ms after its ` +
          `owner disconnected by executions that never settled; releasing it anyway past their ` +
          `${verdict.bound} bound`,
      );
    }
    return undefined;
  }
}
