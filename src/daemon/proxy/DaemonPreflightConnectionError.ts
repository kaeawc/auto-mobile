import { DaemonUnavailableError } from "../client";

/** A transport failed before dispatch, rather than a reconciliation policy gate. */
export class DaemonPreflightConnectionError extends DaemonUnavailableError {
  constructor(readonly cause: DaemonUnavailableError) {
    super(cause.message);
    this.name = "DaemonPreflightConnectionError";
  }
}
