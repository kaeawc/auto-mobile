import { DaemonUnavailableError } from "../DaemonUnavailableError";

/** A private daemon must be relaunched by its owner when its startup policy is unknown. */
export class DaemonRestartOptionsUnknownError extends DaemonUnavailableError {
  readonly code = "daemon_restart_options_unknown";
  readonly retryable = false;

  constructor() {
    super(
      "The private daemon's startup options could not be recovered, so the proxy will not " +
        "start a default daemon (default port 3000) in a private namespace. " +
        "Restart it with its original launcher.",
    );
    this.name = "DaemonRestartOptionsUnknownError";
  }

  toPayload(): { code: string; retryable: boolean } {
    return { code: this.code, retryable: this.retryable };
  }
}
