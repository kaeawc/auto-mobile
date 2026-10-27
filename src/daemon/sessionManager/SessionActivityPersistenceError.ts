import { ActionableError } from "../../models/ActionableError";
/** The daemon could not durably refresh an existing session's liveness. */
export class SessionActivityPersistenceError extends ActionableError {
  constructor(sessionId: string, cause: unknown) {
    super(`Failed to persist liveness activity for session ${sessionId}.`, { cause });
    this.name = "SessionActivityPersistenceError";
  }
}
