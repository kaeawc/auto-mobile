import { DaemonUnavailableError } from "./DaemonUnavailableError";

/** A provision request lost the atomic admission race to an accepted restart. */
export class DaemonRestartPendingError extends DaemonUnavailableError {
  readonly code = "daemon_restart_pending";
  readonly retryable = true;

  constructor() {
    super("Daemon restart is pending; retry provisionDevice after the replacement becomes ready.");
    this.name = "DaemonRestartPendingError";
  }
}
