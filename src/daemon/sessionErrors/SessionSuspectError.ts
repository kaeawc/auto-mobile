import { ActionableError } from "../../models/ActionableError";
import { DAEMON_SESSION_SUSPECT_CODE } from "../types";

/**
 * A tool call reached a session whose owner's lease expired and that is held
 * inside its suspect window (#10051). Nothing runs against it until its owner
 * restores it with a heartbeat from the owner token.
 */
export class SessionSuspectError extends ActionableError {
  /** Travels on the socket response so a proxy can tell "restorable" from "gone" (#10053). */
  readonly code = DAEMON_SESSION_SUSPECT_CODE;

  constructor(
    readonly sessionUuid: string,
    readonly remainingMs: number,
  ) {
    super(
      `Session ${sessionUuid} missed a liveness heartbeat and is being restored; its device ` +
        `stays reserved for ${Math.ceil(remainingMs / 1000)}s. Retry this call now, without ` +
        `waiting. If the retry says the session was released, acquire a device again with ` +
        `getAndroid or getApple.`,
    );
    this.name = "SessionSuspectError";
  }
}
