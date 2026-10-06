import { describe, expect, test } from "bun:test";
import {
  SwipeSearchCancelledError,
  annotateSearchCancellation,
} from "../../../../src/features/action/swipeon/searchCancellation";
import { DeviceLostError } from "../../../../src/models/DeviceLostError";
import { OPERATION_CANCELLED_MESSAGE } from "../../../../src/utils/constants";

const abortedSignal = (): AbortSignal => AbortSignal.abort();

describe("annotateSearchCancellation (#10151)", () => {
  test("a plain cancellation after swipes becomes a typed error with the count and the cause", () => {
    const cause = new Error(OPERATION_CANCELLED_MESSAGE);
    const annotated = annotateSearchCancellation(cause, abortedSignal(), { dispatched: 6 });
    expect(annotated).toBeInstanceOf(SwipeSearchCancelledError);
    expect((annotated as SwipeSearchCancelledError).swipesDispatched).toBe(6);
    expect((annotated as SwipeSearchCancelledError).message).toStartWith(
      OPERATION_CANCELLED_MESSAGE,
    );
    expect((annotated as SwipeSearchCancelledError).cause).toBe(cause);
  });

  test("an AbortError from a device read is treated as the same cancellation", () => {
    const abort = new DOMException("aborted", "AbortError");
    expect(annotateSearchCancellation(abort, abortedSignal(), { dispatched: 1 })).toBeInstanceOf(
      SwipeSearchCancelledError,
    );
  });

  test("a cancellation before the first swipe changed nothing, so it is left generic", () => {
    const cancelled = new Error(OPERATION_CANCELLED_MESSAGE);
    expect(annotateSearchCancellation(cancelled, abortedSignal(), { dispatched: 0 })).toBe(
      cancelled,
    );
  });

  test("a failure while the signal is still live is not a cancellation", () => {
    const failure = new Error(OPERATION_CANCELLED_MESSAGE);
    expect(
      annotateSearchCancellation(failure, new AbortController().signal, { dispatched: 2 }),
    ).toBe(failure);
    expect(annotateSearchCancellation(failure, undefined, { dispatched: 2 })).toBe(failure);
  });

  test("device loss and unrelated failures keep their own type", () => {
    const lost = new DeviceLostError("emulator-5554", "device disconnected");
    const other = new Error("Scroll swipe failed: boom");
    expect(annotateSearchCancellation(lost, abortedSignal(), { dispatched: 3 })).toBe(lost);
    expect(annotateSearchCancellation(other, abortedSignal(), { dispatched: 3 })).toBe(other);
  });

  test("an already annotated error is not wrapped twice", () => {
    const annotated = new SwipeSearchCancelledError(4);
    expect(annotateSearchCancellation(annotated, abortedSignal(), { dispatched: 4 })).toBe(
      annotated,
    );
  });
});
