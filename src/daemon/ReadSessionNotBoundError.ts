import { ActionableError } from "../models/ActionableError";

/**
 * Typed refusal for a read-only call that names a device session another connected client owns
 * (#13540). A `sessionUuid` is not a bearer capability: like a control call, a read under such a
 * session needs the owning connection, a broker grant of it, or the session's owner token.
 * Retrying on the same connection cannot help, so it is not retryable; wire disposition "fail".
 */
export const READ_SESSION_NOT_BOUND_CODE = "read_session_not_bound";

export const READ_SESSION_NOT_BOUND_REMEDY =
  "Read on the connection that owns the session (or present its owner token), or leave " +
  "sessionUuid out and name the device by deviceId for a sessionless read.";

export class ReadSessionNotBoundError extends ActionableError {
  readonly code = READ_SESSION_NOT_BOUND_CODE;
  readonly retryable = false;

  constructor(
    readonly action: string,
    readonly sessionUuid: string,
  ) {
    super(
      `${action} refused: device session ${sessionUuid} is owned by another connected client ` +
        `and this connection does not hold its binding (code ${READ_SESSION_NOT_BOUND_CODE}). ` +
        `A sessionUuid alone does not authorize a read; hold the session binding or present ` +
        `its owner token. ` +
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
