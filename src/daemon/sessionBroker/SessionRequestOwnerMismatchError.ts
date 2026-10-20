import { ActionableError } from "../../models/ActionableError";

/** Retry after the provider has had another opportunity to install or adopt its broker. */
export const SESSION_BROKER_RETRY_AFTER_MS = 1_000;

export class SessionRequestOwnerMismatchError extends ActionableError {
  readonly code: "session_restart_handoff_pending" | "session_owner_mismatch";
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(restartHandoff: boolean) {
    super("Session request belongs to another daemon process generation");
    this.name = "SessionRequestOwnerMismatchError";
    this.code = restartHandoff ? "session_restart_handoff_pending" : "session_owner_mismatch";
    this.retryable = restartHandoff;
    if (restartHandoff) {
      this.retryAfterMs = SESSION_BROKER_RETRY_AFTER_MS;
    }
  }
}
