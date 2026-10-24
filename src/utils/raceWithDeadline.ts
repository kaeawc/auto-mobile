import { ActionableError } from "../models";
import type { AdjustableDeadline } from "./AdjustableDeadline";
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
  /**
   * A movable absolute deadline, used instead of `timeoutMs`. The timer re-arms whenever the
   * deadline moves, so a later (or earlier) deadline applies to a race already in flight.
   */
  deadline?: AdjustableDeadline;
  unref?: boolean;
  signal?: AbortSignal;
  label: string;
  /** Opt into phase-labelled cancellation when downstream code does not classify raw abort reasons. */
  relabelDefaultAbort?: boolean;
  timeoutError?: () => unknown;
  onTimeout?: () => void;
}

/** Arm the race's timeout: a fixed `timeoutMs`, or a movable `deadline` that wins when both are set. */
function armTimeout(
  options: Pick<
    RaceWithDeadlineOptions,
    "timeoutMs" | "deadline" | "unref" | "label" | "timeoutError" | "onTimeout"
  > & { timer: DeadlineTimer },
): { promise: Promise<never>; cancel: () => void } | undefined {
  const { timer, timeoutMs, deadline, unref, label, timeoutError, onTimeout } = options;
  if (deadline === undefined && timeoutMs === undefined) {
    return undefined;
  }
  const fixedMs = timeoutMs ?? 0;
  let cancel: () => void = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    const fail = (message: string): void => {
      reject(timeoutError?.() ?? new ActionableError(message));
      onTimeout?.();
    };
    const unrefHandle = (handle: NodeJS.Timeout): void => {
      if (unref && hasUnref(handle)) {
        handle.unref();
      }
    };
    if (deadline) {
      cancel = deadline.whenExpired(timer, () => fail(`${label} timed out`), unrefHandle);
      return;
    }
    const handle = timer.setTimeout(() => fail(`${label} timed out after ${fixedMs}ms`), fixedMs);
    unrefHandle(handle);
    cancel = () => timer.clearTimeout(handle);
  });
  return { promise, cancel: () => cancel() };
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
    deadline,
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
  const timeout = armTimeout({ timer, timeoutMs, deadline, unref, label, timeoutError, onTimeout });

  try {
    const started = startOperations(operation);
    // A losing operation may still reject after the race has settled.
    suppressLateRejections(started);
    return await Promise.race([
      ...started,
      ...(abortPromise ? [abortPromise] : []),
      ...(timeout ? [timeout.promise] : []),
    ]);
  } finally {
    timeout?.cancel();
    removeAbortListener?.();
  }
}
