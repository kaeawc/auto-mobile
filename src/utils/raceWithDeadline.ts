import { ActionableError } from "../models";
import type { Timer } from "./SystemTimer";

type DeadlineTimer = Pick<Timer, "setTimeout" | "clearTimeout">;

function hasUnref(handle: NodeJS.Timeout): handle is NodeJS.Timeout & { unref: () => unknown } {
  return (
    typeof handle === "object" &&
    handle !== null &&
    "unref" in handle &&
    typeof handle.unref === "function"
  );
}

interface RaceWithDeadlineOptions {
  timer: DeadlineTimer;
  timeoutMs?: number;
  unref?: boolean;
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

function isPromiseArray<T>(
  operation: Promise<T> | readonly Promise<T>[],
): operation is readonly Promise<T>[] {
  return Array.isArray(operation);
}

function asOperations<T>(operation: Promise<T> | readonly Promise<T>[]): readonly Promise<T>[] {
  return isPromiseArray(operation) ? operation : [operation];
}

function startOperations<T>(
  operation: Promise<T> | readonly Promise<T>[] | (() => Promise<T>),
): readonly Promise<T>[] {
  return typeof operation === "function" ? [operation()] : asOperations(operation);
}

function suppressLateRejections<T>(operations: readonly Promise<T>[]): void {
  for (const operation of operations) {
    void operation.then(undefined, () => {});
  }
}

/**
 * Race one or more promises against an optional deadline and abort signal. A thunk starts
 * after the deadline is armed; already-started promises retain their timing.
 * Callers may share the operation, so losing the race never cancels it.
 * Raw abort reasons are preserved by default because callers such as
 * `src/server/deviceTools.ts` classify DOMException(AbortError) cancellations.
 * New callers may opt into #6573-style phase-labelled cancellation with relabelDefaultAbort
 * when downstream code does not require that raw shape.
 */
export function raceWithDeadline<T>(
  operation: Promise<T>,
  options: RaceWithDeadlineOptions,
): Promise<T>;
export function raceWithDeadline<T>(
  operation: () => Promise<T>,
  options: RaceWithDeadlineOptions,
): Promise<T>;
export function raceWithDeadline<T>(
  operation: readonly Promise<T>[],
  options: RaceWithDeadlineOptions,
): Promise<T>;
export async function raceWithDeadline<T>(
  operation: Promise<T> | readonly Promise<T>[] | (() => Promise<T>),
  {
    timer,
    timeoutMs,
    unref = false,
    signal,
    label,
    relabelDefaultAbort = false,
    timeoutError,
    onTimeout,
  }: RaceWithDeadlineOptions,
): Promise<T> {
  // A losing already-started operation may reject before an aborted race starts.
  if (typeof operation !== "function") {
    suppressLateRejections(asOperations(operation));
  }
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
          if (unref && hasUnref(timeoutHandle)) {
            timeoutHandle.unref();
          }
        });

  try {
    const started = startOperations(operation);
    // A losing operation may still reject after the race has settled.
    suppressLateRejections(started);
    return await Promise.race([
      ...started,
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
