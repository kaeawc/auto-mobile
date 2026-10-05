import { ActionableError } from "./ActionableError";
import { errorMessage } from "../utils/describeUnknownError";

/** The gesture completed; only its post-action read failed. Never retry it blindly. */
export class DispatchedObservationError extends ActionableError {
  constructor(cause: unknown) {
    super(
      `Gesture outcome is indeterminate: the gesture was dispatched, but its post-action observation failed (${errorMessage(cause)}). Do not retry automatically. Verify state first with observe.`,
      { cause },
    );
    this.name = "DispatchedObservationError";
  }
}
