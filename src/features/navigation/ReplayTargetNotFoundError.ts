import { ReplayTransientError } from "./ReplayTransientError";

/**
 * A replayed `tapOn` whose target is not on screen and was not found by the bounded
 * scroll search either. Unlike a tap that found its element and still missed, a single
 * one says nothing about whether the edge works when the list is positioned
 * differently; repeated ones do (see `settleTransientEdgeFailure`).
 */
export class ReplayTargetNotFoundError extends ReplayTransientError {
  constructor(message: string) {
    super(message, true);
  }
}
