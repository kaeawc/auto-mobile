import { ActionableError } from "../../models/ActionableError";
import { SESSION_TERMINAL_RELEASE_IN_PROGRESS_CODE } from "../../models/deviceAcquisitionRefusals";
import { ACQUIRE_NEW_SESSION_NEXT_ACTION } from "../../models/deviceSessionRecovery";

/**
 * A session under a kill's terminal release reservation cannot be bound, rebound or reserved again
 * (#11146). It has its own wire code, serialized with `retryable: false` (#11189): the session UUID
 * ends with that release, so only a new UUID (or nothing, for a second kill) can follow. It carries
 * `nextAction: "acquire_new_session"` so runners retry under a fresh session (#11231).
 */
export class SessionTerminalReleaseInProgressError extends ActionableError {
  readonly code = SESSION_TERMINAL_RELEASE_IN_PROGRESS_CODE;
  readonly retryable = false;
  /** The UUID can never recover; a fresh session can (#11098, #11231). */
  readonly nextAction = ACQUIRE_NEW_SESSION_NEXT_ACTION;

  constructor(
    readonly sessionUuid: string,
    readonly deviceId: string,
    detail: string,
  ) {
    super(
      `Session ${sessionUuid} ${detail} (code ${SESSION_TERMINAL_RELEASE_IN_PROGRESS_CODE}, device '${deviceId}').`,
    );
    this.name = "SessionTerminalReleaseInProgressError";
  }
}
