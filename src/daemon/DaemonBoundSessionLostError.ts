import { ActionableError } from "../models/ActionableError";
import { boundSessionLossMessage } from "./types";
import type { BoundSessionLoss } from "./types";

/** A terminal loss of a session explicitly bound to the forwarded request. */
export class DaemonBoundSessionLostError extends ActionableError {
  constructor(readonly failure: BoundSessionLoss) {
    super(boundSessionLossMessage(failure));
    this.name = "DaemonBoundSessionLostError";
  }
}
