import { ActionableError } from "../models";
import type { SessionLogFailureCode, SessionLogSourceFailure } from "./sessionLogContract";

/**
 * A source failure whose cause is known: the service reports its `status` and
 * machine-readable `code` instead of inferring them from the message.
 */
export class SessionLogSourceError extends ActionableError {
  constructor(
    message: string,
    readonly status: Exclude<SessionLogSourceFailure["status"], "timedOut">,
    readonly code: SessionLogFailureCode,
  ) {
    super(message);
    this.name = "SessionLogSourceError";
  }
}
