import { DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS } from "../models/deviceAcquisitionRefusals";
import { ActionableError } from "../models";

/** Shared retry evidence for an emulator whose AVD identity cannot be proved. */
export class AndroidIdentityUnresolvedError extends ActionableError {
  readonly code = "target_identity_unresolved";
  readonly retryable = true;
  readonly retryAfterMs = DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS;
  readonly deviceId?: string;

  constructor(
    message: string,
    readonly candidateSerials: readonly string[],
  ) {
    super(message);
    if (candidateSerials.length === 1) {
      this.deviceId = candidateSerials[0];
    }
  }

  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      candidateSerials: this.candidateSerials,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
    };
  }
}
