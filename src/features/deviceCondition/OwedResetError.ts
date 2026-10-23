import { ActionableError } from "../../models/ActionableError";

/**
 * Thrown by an injector whose `apply` failed AFTER changing the device and could not
 * undo that itself. It carries the reset the controller still owes, so release retries
 * the cleanup and reports the device dirty instead of forgetting the partial state.
 */
export class OwedResetError extends ActionableError {
  constructor(
    message: string,
    readonly owedReset: (signal?: AbortSignal) => Promise<void>,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
