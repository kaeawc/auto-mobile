import { ActionableError } from "../models";
import type { Timer } from "./SystemTimer";

interface RaceWithDeadlineOptions {
  timer: Timer;
  timeoutMs?: number;
  signal?: AbortSignal;
  label: string;
  /** Opt into phase-labelled cancellation when downstream code does not classify raw abort reasons. */
  relabelDefaultAbort?: boolean;
  timeoutError?: () => unknown;
  onTimeout?: () => void;
}

function abortReason(signal: AbortSignal, label: string, relabelDefaultAbort: boolean): unknown {
  const reason: unknown = signal.reason;
  if (
    relabelDefaultAbort &&
    (reason === undefined || (reason instanceof DOMException && reason.name === "AbortError"))
  ) {
    return new ActionableError(`${label} cancelled`);
  }
  return reason === undefined
    ? new DOMException("The operation was aborted.", "AbortError")
    : reason;
}

/**
 * Race an already-started promise against an optional deadline and abort signal.
 * Callers may share the operation, so losing the race never cancels it.
 * Raw abort reasons are preserved by default because callers such as
 * `src/server/deviceTools.ts` classify DOMException(AbortError) cancellations.
 * New callers may opt into #6573-style phase-labelled cancellation with relabelDefaultAbort
 * when downstream code does not require that raw shape.
 */
export async function raceWithDeadline<T>(
  operation: Promise<T>,
  {
    timer,
    timeoutMs,
    signal,
    label,
    relabelDefaultAbort = false,
    timeoutError,
    onTimeout,
  }: RaceWithDeadlineOptions,
): Promise<T> {
  // A losing operation may still reject after the race has settled.
  void operation.then(undefined, () => {});
  if (signal?.aborted) {
    throw abortReason(signal, label, relabelDefaultAbort);
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(abortReason(signal, label, relabelDefaultAbort));
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          onAbort();
        }
      })
    : undefined;
  const timeoutPromise =
    timeoutMs === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          timeoutHandle = timer.setTimeout(() => {
            reject(
              timeoutError?.() ?? new ActionableError(`${label} timed out after ${timeoutMs}ms`),
            );
            onTimeout?.();
          }, timeoutMs);
        });

  try {
    return await Promise.race([
      operation,
      ...(abortPromise ? [abortPromise] : []),
      ...(timeoutPromise ? [timeoutPromise] : []),
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      timer.clearTimeout(timeoutHandle);
    }
    removeAbortListener?.();
  }
}
