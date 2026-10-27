import { ActionableError } from "../../models/ActionableError";
import { DAEMON_SESSION_NOT_ACTIVE_CODE } from "../types";
export class UnissuedSessionError extends ActionableError {
  /** The JSON-RPC `data` the daemon proxy classifies this refusal by, instead of its prose. */
  readonly data = { code: DAEMON_SESSION_NOT_ACTIVE_CODE };
}
