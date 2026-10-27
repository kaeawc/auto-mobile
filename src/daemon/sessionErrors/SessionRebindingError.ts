import { ActionableError } from "../../models/ActionableError";
import {
  DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS,
  SESSION_REBINDING_CODE,
} from "../../models/deviceAcquisitionRefusals";

/**
 * A terminal-release reservation (killDevice) raced the session's own rebind to another device
 * (#11166). The rebind settles on its own, so retrying the shutdown afterwards is safe; it is
 * serialized `retryable: true` with a `retryAfterMs` hint (#11189).
 */
export class SessionRebindingError extends ActionableError {
  readonly code = SESSION_REBINDING_CODE;
  readonly retryable = true;
  readonly retryAfterMs = DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS;

  constructor(readonly sessionUuid: string) {
    super(
      `Session ${sessionUuid} is rebinding devices (code ${SESSION_REBINDING_CODE}); ` +
        "retry shutdown after it settles.",
    );
    this.name = "SessionRebindingError";
  }
}
