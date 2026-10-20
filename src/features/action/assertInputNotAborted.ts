import type { ObservedActionResult } from "./BaseVisualChange";

/**
 * Throw the abort reason unless the action already reported a non-retryable
 * result (a definitive failure must surface as-is, not as an abort).
 */
export function assertInputNotAborted(signal?: AbortSignal, result?: ObservedActionResult): void {
  if (result?.retryable !== false) {
    signal?.throwIfAborted();
  }
}
