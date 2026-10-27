import { ActionableError } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";

/**
 * A non-idempotent `tools/call` failed without structured proof that the daemon
 * never dispatched it (e.g. the connection closed after the request frame was
 * written), so it may already have run on the device. Replaying it could repeat
 * the action (issues #6382, #6383), so the outcome is surfaced instead.
 */
export class DaemonToolOutcomeUnknownError extends ActionableError {
  constructor(
    readonly toolName: string,
    cause: unknown,
  ) {
    super(
      `The daemon request for ${toolName} failed after it may have been delivered, so it may ` +
        `or may not have run on the device (${errorMessage(cause)}). It was not retried ` +
        "automatically to avoid repeating a device action; observe the device state before retrying.",
      { cause },
    );
    this.name = "DaemonToolOutcomeUnknownError";
  }
}
