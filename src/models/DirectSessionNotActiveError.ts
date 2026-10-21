import { ActionableError } from "./ActionableError";
import { ACQUIRE_NEW_SESSION_NEXT_ACTION } from "./deviceSessionRecovery";

/** A direct session without a registry entry cannot fall back to a process-wide device. */
export class DirectSessionNotActiveError extends ActionableError {
  readonly code = "direct_session_not_active";
  readonly retryable = false;
  readonly nextAction = ACQUIRE_NEW_SESSION_NEXT_ACTION;

  constructor(readonly sessionUuid: string) {
    super(
      `Direct session '${sessionUuid}' is not active. ` +
        "Acquire a new device session with getAndroid or getApple and use its sessionUuid.",
    );
    this.name = "DirectSessionNotActiveError";
  }

  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      sessionUuid: this.sessionUuid,
      retryable: this.retryable,
      nextAction: this.nextAction,
    };
  }
}
