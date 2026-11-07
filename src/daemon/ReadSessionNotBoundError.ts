import { ActionableError } from "../models/ActionableError";

/**
 * Typed refusal for a read-only call that names a live device session its connection does not
 * hold (#13540). A `sessionUuid` is not a bearer capability: a read under a session needs the
 * connection that acquired or restored it, a broker grant of it, or the session's owner token.
 * Retrying on the same connection cannot help, so it is not retryable; wire disposition "fail".
 */
export const READ_SESSION_NOT_BOUND_CODE = "read_session_not_bound";

export const READ_SESSION_NOT_BOUND_REMEDY =
  "Read on the connection that acquired the session (or present its owner token), or leave " +
  "sessionUuid out and name the device by deviceId for a sessionless read.";

export class ReadSessionNotBoundError extends ActionableError {
  readonly code = READ_SESSION_NOT_BOUND_CODE;
  readonly retryable = false;

  constructor(
    readonly action: string,
    readonly sessionUuid: string,
  ) {
    super(
      `${action} refused: this connection does not hold device session ${sessionUuid} ` +
        `(code ${READ_SESSION_NOT_BOUND_CODE}). A sessionUuid alone does not authorize a read; ` +
        `the connection must hold the session binding or present its owner token. ` +
        READ_SESSION_NOT_BOUND_REMEDY,
    );
    this.name = "ReadSessionNotBoundError";
  }

  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      action: this.action,
      sessionUuid: this.sessionUuid,
      missingBinding: "session",
      remedy: READ_SESSION_NOT_BOUND_REMEDY,
      retryable: false,
    };
  }
}
