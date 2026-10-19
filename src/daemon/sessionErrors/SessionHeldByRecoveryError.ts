import { ActionableError } from "../../models/ActionableError";
import {
  DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS,
  SESSION_HELD_BY_RECOVERY_CODE,
} from "../../models/deviceAcquisitionRefusals";

/** A late control call waits for session-preserving recovery before judging idle expiry. */
export class SessionHeldByRecoveryError extends ActionableError {
  readonly code = SESSION_HELD_BY_RECOVERY_CODE;
  readonly retryable = true;
  readonly retryAfterMs = DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS;

  constructor(
    readonly sessionUuid: string,
    readonly deviceId: string,
  ) {
    super(
      `Session ${sessionUuid} is past its idle deadline and its device ${deviceId} is being recovered ` +
        `(code ${SESSION_HELD_BY_RECOVERY_CODE}); retry after the recovery settles to receive ` +
        "either the live session or the terminal idle answer.",
    );
    this.name = "SessionHeldByRecoveryError";
  }
}
