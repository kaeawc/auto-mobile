import { ActionableError } from "../../../models/ActionableError";

/** Client hints grow by 1 s per complete episode second, capped at 5 s; no jitter. */
export const BINDING_OWNERSHIP_RETRY_AFTER_MS = 1_000;
export const BINDING_OWNERSHIP_RETRY_MAX_AFTER_MS = 5_000;

export class BindingOwnershipUnconfirmedError extends ActionableError {
  readonly code = "binding_ownership_unconfirmed";
  readonly retryable = true;
  readonly retryAfterMs: number;

  constructor(
    readonly sessionUuid: string,
    episodeAgeMs = 0,
  ) {
    super(
      `Session '${sessionUuid}' binding ownership is not recorded for this daemon yet ` +
        "(the binding registry is busy or the binding is not ready); retry shortly.",
    );
    this.name = "BindingOwnershipUnconfirmedError";
    this.retryAfterMs = Math.min(
      BINDING_OWNERSHIP_RETRY_MAX_AFTER_MS,
      BINDING_OWNERSHIP_RETRY_AFTER_MS * (1 + Math.floor(Math.max(0, episodeAgeMs) / 1_000)),
    );
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
