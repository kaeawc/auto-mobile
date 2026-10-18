import { ActionableError } from "../models/ActionableError";

/**
 * A typed, retryable refusal to bind a device that will become available without the caller
 * doing anything. The daemon does not block acquisition server-side; it returns this and the
 * client waits `retryAfterMs` before retrying, within its own bounded budget.
 */
export class RetryableDeviceAcquisitionError extends ActionableError {
  readonly retryable = true;

  constructor(
    readonly code: string,
    readonly deviceId: string,
    readonly retryAfterMs: number,
    message: string,
  ) {
    super(message);
    this.name = "RetryableDeviceAcquisitionError";
  }
}
