import { ActionableError } from "../../../models/ActionableError";

/**
 * A swipe was dispatched but its outcome was never confirmed. Thrown where a caller needs to stop
 * (not return a result) and still tell the layer that builds the failure result that the swipe may
 * have been applied, so it can set `outcomeIndeterminate` instead of dropping it.
 */
export class SwipeOutcomeIndeterminateError extends ActionableError {
  constructor(message: string) {
    super(message);
    this.name = "SwipeOutcomeIndeterminateError";
  }
}
