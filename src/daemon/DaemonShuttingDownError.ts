import { DAEMON_SHUTTING_DOWN_ERROR_MESSAGE } from "./wire/constants";
import { DaemonUnavailableError } from "./DaemonUnavailableError";

/** Shutdown response; only unadmitted requests are safe to replay unconditionally. */
export class DaemonShuttingDownError extends DaemonUnavailableError {
  constructor(readonly requestMayHaveDispatched = false) {
    super(DAEMON_SHUTTING_DOWN_ERROR_MESSAGE);
    this.name = "DaemonShuttingDownError";
  }
}
