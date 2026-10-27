import { ActionableError } from "../models/ActionableError";
import type { DaemonHandshakeFailure } from "./wire/daemonHandshake";

/** The server rejected this request before dispatch; retry cannot duplicate work. */
export class DaemonHandshakeMismatchError extends ActionableError {
  constructor(
    readonly failure: DaemonHandshakeFailure,
    message: string,
  ) {
    super(`Daemon preflight failed; no device operation started. ${message}`);
    this.name = "DaemonHandshakeMismatchError";
  }
}
