import { ActionableError } from "../../models/ActionableError";
import { SESSION_BROKER_RETRY_AFTER_MS } from "./timing";

/** No request was admitted or abandoned; retry the same identity against the successor daemon. */
export class SessionBrokerStoppingError extends ActionableError {
  readonly code = "session_broker_stopping";
  readonly retryable = true;
  readonly retryAfterMs = SESSION_BROKER_RETRY_AFTER_MS;

  constructor() {
    super("Session broker is stopping");
    this.name = "SessionBrokerStoppingError";
  }
}
