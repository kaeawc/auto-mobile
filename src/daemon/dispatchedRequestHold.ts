import { ActionableError } from "../models";
import { runWithAbortSignal } from "../utils/AbortContext";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";

/** Optional transport seam: socket callers hold; other callers keep their cancellation policy. */
export type DispatchedRequestHold = <T>(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  send: (fenced: AbortSignal | undefined, onDispatch: () => void) => Promise<T>,
  onDispatch?: () => void,
) => Promise<T>;

/**
 * Before send, abort the fence in the same tick. After send, abort stops the NEXT
 * operation, not this wait: hold until reply/error or the original remaining budget.
 * The admission latch only chooses the answer; this fence prevents a late send.
 */
export async function holdDispatchedRequest<T>({
  timer,
  signal,
  timeoutMs,
  label,
  send,
  onDispatch,
}: {
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  signal?: AbortSignal;
  timeoutMs: number;
  label: string;
  send: (fenced: AbortSignal | undefined, onDispatch: () => void) => Promise<T>;
  onDispatch?: () => void;
}): Promise<T> {
  signal?.throwIfAborted();
  const deadline = timer.now() + timeoutMs;
  const fence = new AbortController();
  let dispatched = false;
  let timeout: ReturnType<Timer["setTimeout"]> | undefined;
  const onAbort = () => {
    if (!dispatched) {
      fence.abort(signal?.reason);
      return;
    }
    // Do not restart the budget at abort, and do not change the ordinary timeout hold.
    timeout = timer.setTimeout(
      () => {
        const error = new ActionableError(`${label} deadline expired after dispatch`);
        fence.abort(error);
      },
      Math.max(0, deadline - timer.now()),
    );
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const fenced = signal ? fence.signal : undefined;
  try {
    const request = runWithAbortSignal(fenced, () =>
      send(fenced, () => {
        fenced?.throwIfAborted();
        dispatched = true;
        onDispatch?.();
      }),
    );
    return await raceWithDeadline(request, {
      timer,
      signal: fenced,
      label,
    });
  } finally {
    if (timeout !== undefined) {
      timer.clearTimeout(timeout);
    }
    signal?.removeEventListener("abort", onAbort);
  }
}
