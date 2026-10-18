import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { SessionRecoveryAssignmentDetails } from "../../models/SessionRecoveryAssignmentError";
import { readToolEnvelopePayload } from "../../server/toolEnvelopePayload";
import { idleReleaseField } from "../releaseReasons";
import { BOUND_SESSION_LOSS_CODE, type BoundSessionLoss } from "../types";
import { ReleasedBoundSessionError } from "./ReleasedBoundSessionError";

/**
 * Bound-session recovery for the control socket (#11815): what a forward does when the session it
 * names was already released. A release inside its restart-recovery window is admitted (the
 * session may be recovered); any other release fails the call with the terminal release the owner
 * is told. The server owns the session manager; this module reaches it only through
 * {@link BoundSessionRecoveryPort}.
 */

/** The release facts recovery reads; each method resolves the session manager on every call. */
export interface BoundSessionRecoveryPort {
  /** True while the released session may still be recovered after a daemon restart. */
  isReleasedSessionInRestartRecoveryWindow(sessionUuid: string): Promise<boolean | undefined>;
  /** The terminal release the daemon recorded, when it recorded one. */
  terminalReleaseSnapshot(sessionUuid: string): BoundSessionLoss["release"] | undefined;
  /** The release of a session whose row ran out its window with no daemon holding it (#11361). */
  expiredReleaseSnapshot(sessionUuid: string): Promise<BoundSessionLoss["release"] | undefined>;
}

/** A retryable `session_recovery_pending` error that names exactly this session. */
export function isRetryableSessionRecoveryResult(response: unknown, sessionUuid: string): boolean {
  if (
    !response ||
    typeof response !== "object" ||
    !("isError" in response) ||
    response.isError !== true
  ) {
    return false;
  }
  const error = readToolEnvelopePayload(response)?.payload.error as
    | Partial<SessionRecoveryAssignmentDetails>
    | undefined;
  return (
    error?.code === "session_recovery_pending" &&
    error.retryable === true &&
    error.sessionUuid === sessionUuid
  );
}

export class DeviceControlTransportRecovery {
  constructor(private readonly port: BoundSessionRecoveryPort) {}

  /**
   * Run `forward`, first admitting the session `releasedSessionUuid` names when the bound session
   * was released. `releasedSessionUuid` is `undefined` for a healthy session: that path calls
   * `forward` synchronously, so routing and forwarding keep starting in the caller's tick.
   */
  withAdmittedBoundSession<T>(
    releasedSessionUuid: string | undefined,
    forward: (recoverableSessionUuid?: string) => T,
  ): T | Promise<T> {
    if (releasedSessionUuid === undefined) {
      // Keep healthy routing and forwarding synchronous up to the existing I/O.
      return forward();
    }
    return this.admitReleasedBoundSession(releasedSessionUuid).then(() =>
      forward(releasedSessionUuid),
    );
  }

  private async admitReleasedBoundSession(sessionUuid: string): Promise<void> {
    try {
      if (await this.port.isReleasedSessionInRestartRecoveryWindow(sessionUuid)) {
        return;
      }
    } catch (error) {
      logger.warn(
        `Unable to read restart recovery window for bound session ${sessionUuid}: ${errorMessage(error)}`,
        error,
      );
    }
    const release =
      this.port.terminalReleaseSnapshot(sessionUuid) ??
      (await this.expiredBoundSessionRelease(sessionUuid));
    throw new ReleasedBoundSessionError({
      code: BOUND_SESSION_LOSS_CODE,
      sessionUuid,
      reason: release?.releaseReason ?? "session-not-found",
      ...idleReleaseField(release?.releaseReason),
      ...(release ? { release } : {}),
    });
  }

  /**
   * The release of a bound session whose row ran out its window with no daemon holding it
   * (#11361), so its owner is told `expired` rather than `session-not-found`. Best-effort: a
   * failed read keeps the fail-closed not-found answer.
   */
  private async expiredBoundSessionRelease(
    sessionUuid: string,
  ): Promise<BoundSessionLoss["release"] | undefined> {
    try {
      return await this.port.expiredReleaseSnapshot(sessionUuid);
    } catch (error) {
      logger.warn(
        `Unable to read the expired release of bound session ${sessionUuid}: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }
}
