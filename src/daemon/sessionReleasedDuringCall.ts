import { ActionableError } from "../models/ActionableError";
import { ACQUIRE_NEW_SESSION_NEXT_ACTION } from "../models/deviceSessionRecovery";
import type { SessionReleaseReason } from "./releaseReasons";

/** The wire code of a terminal-session refusal: the named session UUID is gone for good. */
export const SESSION_OWNERSHIP_LOST_CODE = "session_ownership_lost" as const;

/**
 * Why a call was cancelled: the daemon released the session it was running under (#11322). Every
 * release that ends the session for a reason of its own (heartbeat reap, idle expiry, owner
 * disconnect) cancels the session's in-flight calls with this, so the caller gets the typed
 * terminal refusal (`session_ownership_lost`) rather than a generic abort (#11381). A read is the
 * usual recipient: it is answered whatever the owner lease says, but it does not keep the session,
 * so the release can land while it is still running.
 *
 * It carries the refusal's wire fields itself, so a path that reports a thrown error by its typed
 * fields (the control socket's failure frame) answers the same refusal as the MCP envelope.
 *
 * Kept free of the session machinery so the wire layer can recognise it without loading the daemon.
 */
export class SessionReleasedDuringCallError extends ActionableError {
  readonly code = SESSION_OWNERSHIP_LOST_CODE;
  readonly retryable = false;
  readonly nextAction = ACQUIRE_NEW_SESSION_NEXT_ACTION;
  readonly details: { sessionUuid: string; reason: SessionReleaseReason };

  constructor(
    readonly sessionUuid: string,
    readonly releaseReason: SessionReleaseReason,
  ) {
    super(
      `Session ${sessionUuid} is terminal after ${releaseReason} and cannot be reused; it was ` +
        "released while this call was in flight, so the call was cancelled. " +
        "Acquire a new device with getAndroid or getApple.",
    );
    this.name = "SessionReleasedDuringCallError";
    this.details = { sessionUuid, reason: releaseReason };
  }
}

/**
 * The session release that cancelled a call, or undefined when `cancelReason` (the execution
 * tracker's record of why the call was aborted) is anything else. The one test every wire path
 * uses to answer a call the release cut (#11381): the MCP server builds its envelope from it, and
 * the control socket's `input/*` path rethrows it so its failure frame carries the typed fields.
 */
export function sessionReleaseThatCancelledCall(
  cancelReason: unknown,
): SessionReleasedDuringCallError | undefined {
  return cancelReason instanceof SessionReleasedDuringCallError ? cancelReason : undefined;
}
