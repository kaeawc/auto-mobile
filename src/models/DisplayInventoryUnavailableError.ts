import { ActionableError } from "./ActionableError";

export interface DisplayInventoryUnavailableDetails {
  pin?: string;
  retryable: true;
}

export class DisplayInventoryUnavailableError extends ActionableError {
  readonly details: DisplayInventoryUnavailableDetails;
  constructor(input: { pin?: string; cause?: unknown }) {
    super(
      "The display inventory could not be read. Please retry the request; the session display pin has been kept.",
      { cause: input.cause },
    );
    this.name = "DisplayInventoryUnavailableError";
    this.details = { ...(input.pin === undefined ? {} : { pin: input.pin }), retryable: true };
  }
}
