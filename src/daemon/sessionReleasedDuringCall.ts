import { ActionableError } from "../models/ActionableError";
import type { SessionReleaseReason } from "./releaseReasons";

/**
 * Why a call was cancelled: the daemon released the session it was running under (#11322). The
 * heartbeat monitor cancels a released session's in-flight calls with this, so the caller gets the
 * typed terminal refusal (`session_ownership_lost`) rather than a generic abort. A read is the
 * usual recipient: it is answered whatever the owner lease says, but it does not keep the session,
 * so the release can land while it is still running.
 *
 * Kept free of the session machinery so the wire layer can recognise it without loading the daemon.
 */
export class SessionReleasedDuringCallError extends ActionableError {
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
  }
}
