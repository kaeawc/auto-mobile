import type { ExecutionTracker } from "./executionTracker";

/** Follow client cancellation for admission only; the caller unsubscribes when the call ends. */
export function subscribeRequestCancellation(
  tracker: Pick<ExecutionTracker, "markRequestCancelled">,
  executionId: string,
  signal: AbortSignal,
): () => void {
  const markCancelled = () => tracker.markRequestCancelled(executionId);
  if (signal.aborted) {
    markCancelled();
  } else {
    signal.addEventListener("abort", markCancelled, { once: true });
  }
  return () => signal.removeEventListener("abort", markCancelled);
}
