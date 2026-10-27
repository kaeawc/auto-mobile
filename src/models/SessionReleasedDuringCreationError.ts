import { ActionableError } from "./ActionableError";
import { ACQUIRE_NEW_SESSION_NEXT_ACTION } from "./deviceSessionRecovery";

/**
 * A session that was being created on demand was released before its creation returned (for
 * example an executePlan label session whose base was released mid-setup, #11146). The caller lost
 * the race; nothing is bound under its UUID.
 */
export const SESSION_RELEASED_DURING_CREATION_CODE = "session_released_during_creation";

export class SessionReleasedDuringCreationError extends ActionableError {
  readonly code = SESSION_RELEASED_DURING_CREATION_CODE;
  readonly retryable = false;
  readonly nextAction = ACQUIRE_NEW_SESSION_NEXT_ACTION;

  constructor(readonly sessionUuid: string) {
    super(
      `Session ${sessionUuid} was released while it was being created ` +
        `(code ${SESSION_RELEASED_DURING_CREATION_CODE}); no device is bound to it. ` +
        "Acquire a new session with getAndroid or getApple.",
    );
    this.name = "SessionReleasedDuringCreationError";
  }
}
