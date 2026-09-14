import { ActionableError } from "../models";

export const DAEMON_HANDOFF_INTERRUPTED_ERROR_CODE = "daemon_handoff_interrupted";
export const DAEMON_HANDOFF_INTERRUPTED_MESSAGE =
  "Daemon handoff interrupted the in-flight request. Retry after the replacement daemon becomes ready.";

/**
 * The daemon lifecycle interrupted an admitted request while transferring
 * ownership to a replacement generation. Retrying is safe for idempotent
 * operations such as provisionDevice's operationId-backed lifecycle.
 */
export class DaemonHandoffInterruptionError extends ActionableError {
  readonly code = DAEMON_HANDOFF_INTERRUPTED_ERROR_CODE;
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = "DaemonHandoffInterruptionError";
  }
}
