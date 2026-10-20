import { ActionableError } from "../../../models/ActionableError";

/** The SDK probe could not establish availability; retry against the current connection. */
export class SdkCapabilityQueryError extends ActionableError {
  readonly retryable = true;

  toPayload(): Record<string, unknown> {
    return { code: this.code, retryable: this.retryable };
  }

  constructor(
    readonly code: "cancelled" | "timeout" | "not_connected" | "sdk_capability_query_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SdkCapabilityQueryError";
  }
}
