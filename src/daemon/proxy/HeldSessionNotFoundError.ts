import type { NotFoundAnswerOutcome } from "./notFoundDecision";

/**
 * The daemon answered a session's heartbeat with "session not found", and what that means for the
 * session ({@link decideNotFoundAnswer}). Thrown instead of the raw error so the shared reconnect
 * machinery (which resets the one daemon socket and retries "stale session" errors) is not
 * triggered by a per-session answer.
 */
export class HeldSessionNotFoundError extends Error {
  constructor(
    readonly sessionUuid: string,
    readonly outcome: NotFoundAnswerOutcome,
  ) {
    // Deliberately not the daemon's "Session not found" wording, which the reconnect machinery matches on.
    super(`The daemon does not know held session ${sessionUuid}`);
    this.name = "HeldSessionNotFoundError";
  }
}
