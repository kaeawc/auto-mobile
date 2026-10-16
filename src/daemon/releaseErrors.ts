import { ActionableError } from "../models/ActionableError";

/** Logged reason when a release write outlives the session release persist timeout. */
export const RELEASE_PERSIST_TIMEOUT_REASON = "release-persist-timeout";

/** A release's `markReleased` write did not settle within its deadline (#10836). */
export class SessionReleasePersistTimeoutError extends ActionableError {
  readonly reason = RELEASE_PERSIST_TIMEOUT_REASON;

  constructor(
    readonly sessionId: string,
    readonly releaseReason: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Persisting the ${releaseReason} release of session ${sessionId} did not finish within ` +
        `${timeoutMs}ms (reason=${RELEASE_PERSIST_TIMEOUT_REASON}).`,
    );
    this.name = "SessionReleasePersistTimeoutError";
  }
}
