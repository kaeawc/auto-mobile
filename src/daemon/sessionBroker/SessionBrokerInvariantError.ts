import { ActionableError } from "../../models/ActionableError";

/** A store precondition failed; retrying cannot establish the missing ownership or state. */
export class SessionBrokerInvariantError extends ActionableError {
  readonly code = "session_broker_invariant_failed";
}
