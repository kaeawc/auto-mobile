import { ActionableError } from "../../models/ActionableError";
import type { SessionReleaseSnapshot } from "../sessionManager";

/** A new session cannot be published after the daemon has begun shutdown. */
export class DaemonSessionCreationRejectedError extends ActionableError {
  constructor(
    readonly sessionUuid: string,
    readonly release?: SessionReleaseSnapshot,
  ) {
    super(`Cannot create device session ${sessionUuid}: the daemon is shutting down.`);
    this.name = "DaemonSessionCreationRejectedError";
  }
}
