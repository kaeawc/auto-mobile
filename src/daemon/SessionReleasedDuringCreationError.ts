import { ACQUIRE_NEW_SESSION_NEXT_ACTION } from "../models/deviceSessionRecovery";
import { ActionableError } from "../models/ActionableError";
import { SESSION_RELEASED_DURING_CREATION_CODE } from "./deviceAcquisitionRefusals";

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
