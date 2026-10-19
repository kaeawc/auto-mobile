import { ActionableError } from "../../../models/ActionableError";

/** Retry hint matching the re-owner's steady-state 1 s cadence while ownership is unconfirmed. */
export const BINDING_OWNERSHIP_RETRY_AFTER_MS = 1_000;

export class BindingOwnershipUnconfirmedError extends ActionableError {
  readonly code = "binding_ownership_unconfirmed";
  readonly retryable = true;
  readonly retryAfterMs = BINDING_OWNERSHIP_RETRY_AFTER_MS;

  constructor(readonly sessionUuid: string) {
    super(
      `Session '${sessionUuid}' binding ownership is not recorded for this daemon yet ` +
        "(the binding registry is busy or the binding is not ready); retry shortly.",
    );
    this.name = "BindingOwnershipUnconfirmedError";
  }

  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      sessionUuid: this.sessionUuid,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
    };
  }
}
