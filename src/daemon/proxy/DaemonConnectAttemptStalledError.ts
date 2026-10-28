import { DaemonUnavailableError } from "../client/client";

/**
 * A daemon connection attempt did not settle within its bound (#15019). The attempt is
 * abandoned and its single-flight slot freed, so retrying starts a fresh attempt.
 */
export class DaemonConnectAttemptStalledError extends DaemonUnavailableError {
  constructor(readonly attemptTimeoutMs: number) {
    super(`Daemon connection attempt did not settle within ${attemptTimeoutMs}ms`);
    this.name = "DaemonConnectAttemptStalledError";
  }
}
