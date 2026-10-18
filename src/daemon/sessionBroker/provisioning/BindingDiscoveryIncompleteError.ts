import { ActionableError } from "../../../models/ActionableError";
import { BINDING_DISCOVERY_INCOMPLETE_CODE, BINDING_DISCOVERY_RETRY_AFTER_MS } from "./refusal";

export class BindingDiscoveryIncompleteError extends ActionableError {
  readonly code = BINDING_DISCOVERY_INCOMPLETE_CODE;
  readonly retryable = true;
  readonly retryAfterMs = BINDING_DISCOVERY_RETRY_AFTER_MS;

  constructor(cause: string) {
    super(
      `The binding registry is unreadable (${cause}), so assigned devices cannot be told ` +
        `apart from free ones (code ${BINDING_DISCOVERY_INCOMPLETE_CODE}); retry shortly.`,
    );
    this.name = "BindingDiscoveryIncompleteError";
  }

  toPayload(): Record<string, unknown> {
    return { code: this.code, retryable: true, retryAfterMs: this.retryAfterMs };
  }
}
