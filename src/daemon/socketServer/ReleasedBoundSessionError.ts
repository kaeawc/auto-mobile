import { boundSessionLossMessage, type BoundSessionLoss } from "../types";

/** Thrown when a forward names a session that was released outside its restart-recovery window. */
export class ReleasedBoundSessionError extends Error {
  constructor(readonly failure: BoundSessionLoss) {
    super(boundSessionLossMessage(failure));
    this.name = "ReleasedBoundSessionError";
  }
}
