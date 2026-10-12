import { ActionableError } from "../models/ActionableError";

/**
 * A kill's terminal-release reservation named a device the session no longer holds (#11166).
 * Not retryable as-is: the device's holder changed, so the caller re-checks before killing.
 */
export const SESSION_NO_LONGER_OWNS_DEVICE_CODE = "session_no_longer_owns_device";

/**
 * A terminal-release reservation (killDevice) named a device the session no longer holds: the
 * session was rebound or released since the caller resolved it (#11166). Re-resolve the device's
 * current session and retry, rather than release a session that moved on. Serialized with
 * `retryable: false` (#11189): the device's holder changed, so a blind repeat of a destructive
 * kill could stop a device another session now owns.
 *
 * A direct `input/*` or `ide/*` frame admitted for a holder that has since left the device is the
 * same refusal (#11351): nothing was sent, and a repeat would drive a device the session no
 * longer holds. It lives apart from the session manager so the input and wire layers can throw it
 * without importing that module.
 */
export class SessionNoLongerOwnsDeviceError extends ActionableError {
  readonly code = SESSION_NO_LONGER_OWNS_DEVICE_CODE;
  readonly retryable = false;

  constructor(
    readonly sessionUuid: string,
    readonly deviceId: string,
    /** Replaces the composed message where a caller's existing wording must stay stable. */
    message?: string,
  ) {
    super(
      message ??
        `Session ${sessionUuid} no longer owns device ${deviceId} ` +
          `(code ${SESSION_NO_LONGER_OWNS_DEVICE_CODE}); it was rebound or released. ` +
          "Re-resolve the device's current session and retry.",
    );
    this.name = "SessionNoLongerOwnsDeviceError";
  }
}
