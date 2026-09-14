import type { Timer } from "./SystemTimer";

/**
 * Invoke an operation with the caller's still-live cancellation signal and the
 * time remaining before its absolute deadline. The operation owns enforcing the
 * supplied timeout at its process/I/O boundary.
 */
export async function withRemainingBudget<T>(
  deadlineMs: number,
  timer: Pick<Timer, "now">,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal | undefined, remainingMs: number) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const remainingMs = deadlineMs - timer.now();
  if (remainingMs <= 0) {
    throw new Error("Operation budget elapsed");
  }
  return await operation(signal, remainingMs);
}
