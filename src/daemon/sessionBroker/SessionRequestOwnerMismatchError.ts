import { ActionableError } from "../../models/ActionableError";
import { SESSION_BROKER_RETRY_AFTER_MS } from "./timing";

export { SESSION_BROKER_RETRY_AFTER_MS } from "./timing";

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
