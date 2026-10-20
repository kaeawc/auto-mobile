import type { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";

/** Helpers shared by TapOnElement and TapAnyElement (#11832). */

export interface SearchUntilPollOptions<T> {
  timer: Timer;
  /** Wall-clock start of the search window; the deadline is `startTime + durationMs`. */
  startTime: number;
  durationMs: number;
  intervalMs: number;
  /**
   * `cadence` polls immediately, then at a fixed `intervalMs` rhythm measured from the previous
   * poll's start (a slow refresh shortens the next wait). `sleepFirst` always sleeps one full
   * `intervalMs` before every poll, including the first.
   */
  pacing: "cadence" | "sleepFirst";
  /** Independent request ceiling, so fast cached responses still yield even if the clock stalls. */
  maxRequests?: number;
  /**
   * Stop without offering a result that arrived at or after the deadline. A late candidate must
   * not be tapped: the refresh may have served a stale fallback after its own timeout.
   */
  discardLateResult: boolean;
  signal?: AbortSignal;
  /** One hierarchy request bounded by the time left in the window; `null` means none arrived. */
  fetch: (remainingMs: number) => Promise<T | null>;
  /** Inspect a fetched result; return true to stop polling (target found). */
  accept: (result: T) => boolean;
}

/** Poll `fetch` until `accept` succeeds, the window closes, or the request ceiling is hit. */
export async function pollSearchUntil<T>(
  options: SearchUntilPollOptions<T>,
): Promise<{ requestCount: number }> {
  const { timer, signal } = options;
  const deadline = options.startTime + options.durationMs;
  const maxRequests = options.maxRequests ?? Number.POSITIVE_INFINITY;
  let requestCount = 0;
  let nextPollAt = options.startTime;
  while (timer.now() < deadline && requestCount < maxRequests) {
    throwIfAborted(signal);
    if (options.pacing === "sleepFirst") {
      await timer.sleep(options.intervalMs);
    } else {
      const delayMs = Math.min(nextPollAt, deadline) - timer.now();
      if (delayMs > 0) {
        await timer.sleep(delayMs);
        throwIfAborted(signal);
      }
    }
    if (timer.now() >= deadline) {
      break;
    }
    nextPollAt = timer.now() + options.intervalMs;
    const result = await options.fetch(Math.max(0, deadline - timer.now()));
    requestCount += 1;
    if (!result) {
      continue;
    }
    if (options.discardLateResult && timer.now() >= deadline) {
      break;
    }
    if (options.accept(result)) {
      break;
    }
  }
  return { requestCount };
}
