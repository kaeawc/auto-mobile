import { ActionableError } from "../../../models/ActionableError";
import { isDeviceLostError } from "../../../models/DeviceLostError";
import { StaleDisplayError } from "../../../models/StaleDisplayError";
import type { SwipeResult } from "../../../models/SwipeResult";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { Timer } from "../../../utils/interfaces/Timer";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../../utils/toolUtils";

const FORWARD_DELIVERED_NOTE =
  "Boomerang partially applied: the forward swipe was delivered, so the content has moved. Observe before retrying; do not retry automatically.";

/** Failure result for a return swipe that did not succeed after the forward swipe landed. */
function returnLegFailure(returnResult: SwipeResult): SwipeResult {
  return {
    ...returnResult,
    success: false,
    error: `Boomerang partially applied: the forward swipe was delivered; the return swipe failed (${returnResult.error ?? "unknown error"}). The content has moved. Observe before retrying; do not retry automatically.`,
    retryable: false,
    partialApplication: true,
  };
}

/**
 * Attach the partial-application note to an error thrown after the forward swipe landed.
 * Typed carriers that callers branch on (device loss, stale display) pass through unchanged.
 */
export function withForwardDeliveredNote(error: unknown): unknown {
  if (isDeviceLostError(error) || error instanceof StaleDisplayError) {
    return error;
  }
  const noted = new ActionableError(`${errorMessage(error)}. ${FORWARD_DELIVERED_NOTE}`, {
    cause: error,
  });
  forwardDeliveredErrors.add(noted);
  return noted;
}

/** Errors produced by {@link withForwardDeliveredNote}, so callers can recognise the note. */
const forwardDeliveredErrors = new WeakSet<object>();

/**
 * Replacement for a catch block's `throwIfAborted(signal)`. A cancelled request normally replaces
 * whatever was caught with the plain cancellation, which would drop the "forward swipe was
 * delivered" note carried by `error` (issue #9973 follow-up). When `error` carries that note, the
 * cancellation the caller sees carries it too; device-loss carriers stay typed and unchanged.
 */
export function throwIfAbortedKeepingForwardNote(signal: AbortSignal | undefined, error: unknown) {
  try {
    throwIfAborted(signal);
  } catch (abort) {
    const carriesNote =
      typeof error === "object" && error !== null && forwardDeliveredErrors.has(error);
    throw carriesNote ? withForwardDeliveredNote(abort) : abort;
  }
}

/**
 * Run everything after a SUCCESSFUL forward boomerang swipe: the cancellable apex pause, then the
 * return swipe. The forward swipe has already moved the content, so a return-leg failure, a
 * cancellation, or a thrown error must say so instead of reading as a plain swipe failure
 * (issue #9973). A failed return leg comes back as a non-retryable partial-application result
 * (keeping the leg's `outcomeIndeterminate` / `fallbackReason`); a throw is rethrown with the note.
 */
export async function runBoomerangReturnLeg(options: {
  timer: Pick<Timer, "sleep">;
  apexPauseMs: number;
  signal?: AbortSignal;
  returnSwipe: () => Promise<SwipeResult>;
}): Promise<SwipeResult> {
  const { timer, apexPauseMs, signal, returnSwipe } = options;
  try {
    throwIfAborted(signal);
    if (apexPauseMs > 0) {
      await awaitWhileRequestIsLive(timer.sleep(apexPauseMs), signal);
    }
    throwIfAborted(signal);
    const returnResult = await returnSwipe();
    return returnResult.success ? returnResult : returnLegFailure(returnResult);
  } catch (error) {
    throw withForwardDeliveredNote(error);
  }
}
