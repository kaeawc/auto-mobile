import { type BoundSessionLoss, boundSessionLossMessage } from "../types";

export class ReleasedBoundSessionError extends Error {
  constructor(readonly failure: BoundSessionLoss) {
    super(boundSessionLossMessage(failure));
    this.name = "ReleasedBoundSessionError";
  }
}
