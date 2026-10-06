import { isDeviceLostError } from "../../../models/DeviceLostError";
import { OPERATION_CANCELLED_MESSAGE } from "../../../utils/constants";

/**
 * A cancelled `lookFor` search that had already moved the screen (#10151). The message keeps the
 * generic cancellation text as its prefix so callers that match on it still classify this as a
 * cancellation, and adds how many swipes were dispatched so the caller knows the screen is no
 * longer where it started.
 */
export class SwipeSearchCancelledError extends Error {
  constructor(
    readonly swipesDispatched: number,
    options?: { cause?: unknown },
  ) {
    super(
      `${OPERATION_CANCELLED_MESSAGE} after ${swipesDispatched} swipe(s) were dispatched; ` +
        "the screen has scrolled. Observe before retrying.",
      options,
    );
    this.name = "SwipeSearchCancelledError";
  }
}

/**
 * Counts the gestures one search reported as handed to the device; shared by the loop and its
 * recoveries. A path that cannot see its own send point (legacy executors, TalkBack) counts as it
 * begins the send, so there the count is an attempt, never fewer than were sent.
 */
export interface SwipeCounter {
  dispatched: number;
}

const isPlainCancellation = (error: unknown): error is Error =>
  error instanceof Error &&
  (error.message === OPERATION_CANCELLED_MESSAGE || error.name === "AbortError");

/**
 * Report how far a cancelled search got. Only a plain cancellation of a search that dispatched at
 * least one swipe is rewritten; a device-loss error or any other failure keeps its own type, and a
 * cancellation before the first swipe changed nothing, so it stays the generic one.
 */
export function annotateSearchCancellation(
  error: unknown,
  signal: AbortSignal | undefined,
  counter: SwipeCounter,
): unknown {
  if (
    !signal?.aborted ||
    counter.dispatched === 0 ||
    isDeviceLostError(error) ||
    !isPlainCancellation(error)
  ) {
    return error;
  }
  return new SwipeSearchCancelledError(counter.dispatched, { cause: error });
}
