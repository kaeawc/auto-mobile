import { ActionableError } from "../../models/ActionableError";

export const SESSION_REQUEST_OWNER_MISMATCH_CODE = "session_request_owner_mismatch";

/**
 * A liveness owner token that does not own a session request (#18150). Ownership protects binding
 * and release, so the refusal tells a non-owner only whether the request is finished.
 */
export class SessionRequestForeignOwnerError extends ActionableError {
  readonly code = SESSION_REQUEST_OWNER_MISMATCH_CODE;
  readonly retryable = false;

  constructor(readonly terminal: boolean) {
    super("Session request belongs to another liveness owner");
    this.name = "SessionRequestForeignOwnerError";
  }
}
