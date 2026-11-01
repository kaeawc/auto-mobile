import { ActionableError } from "../../models/ActionableError";
import { SESSION_BROKER_RETRY_AFTER_MS } from "./timing";

/** No receipt was written; the caller may retry its original request identity. */
export class SessionBrokerMaintenanceError extends ActionableError {
  readonly code = "session_broker_maintenance";
  readonly retryable = true;
  readonly retryAfterMs = SESSION_BROKER_RETRY_AFTER_MS;

  constructor() {
    super("Session broker snapshot maintenance is running; retry shortly");
    this.name = "SessionBrokerMaintenanceError";
  }
}
