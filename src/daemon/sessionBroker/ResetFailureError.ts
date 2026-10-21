import { ActionableError } from "../../models/ActionableError";
import type { ResetOutcome } from "./devicePort";

export class ResetFailureError extends ActionableError {
  constructor(
    message: string,
    readonly reset: ResetOutcome,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
