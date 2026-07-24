import type { ObserveResult } from "../../models";
import type { ObserveScreen } from "./interfaces/ObserveScreen";
import { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";

/**
 * Shared observe poll loop for the settle / wait-for-condition primitives
 * (issue #4389). Both are the same loop with a different stop test, so the
 * monotonic-freshness and budget logic — the subtle correctness — lives here
 * once.
 */
export interface ObservePollOptions {
  /** Hard budget in ms. Mandatory: the loop can never outlast it. */
  timeoutMs: number;
  /** Poll interval in ms between observations. */
  pollMs: number;
  signal?: AbortSignal;
}

export interface ObservePollOutcome {
  /** The observation the loop stopped on (matched/settled, or last polled). */
  observation: ObserveResult;
  /** Number of observations taken. */
  polls: number;
  /** Wall-clock spent (per the injected Timer). */
  waitMs: number;
  /**
   * True when `onObservation` requested the stop (matched/settled); false when
   * the loop exited on the budget or a screen-off fast-fail.
   */
  stopped: boolean;
}

/**
 * `ObserveResult.updatedAt` is documented as ms-since-epoch but typed
 * `string | number` (it falls back to a server timestamp). Coerce to a number so
 * the next poll's `minTimestamp` is monotonic; a numeric string parses directly,
 * an ISO string via `Date.parse`, and anything unparseable falls back to 0 so a
 * bad timestamp degrades to "accept any fresh read" rather than throwing.
 */
function toMillis(updatedAt: string | number): number {
  if (typeof updatedAt === "number") {
    return updatedAt;
  }
  const numeric = Number(updatedAt);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Screen-off is Android-only (`wakefulness`). iOS observations carry no
 * wakefulness signal, so they read as awake — the loop stays cross-platform.
 */
function isScreenOff(observation: ObserveResult): boolean {
  return observation.wakefulness === "Asleep";
}

/**
 * Poll `observeScreen` until `onObservation` returns true or the budget expires.
 *
 * The correctness point: each poll requests `minTimestamp = previous.updatedAt`
 * (the first seeds from loop start), so every read is genuinely newer than the
 * last. Passing a fixed `minTimestamp` would let two polls read the *same cached
 * tree* and false-settle. On a screen-off (Android) capture the loop fast-fails
 * rather than burning the budget against a dark screen.
 */
export async function pollObserveUntil(
  observeScreen: ObserveScreen,
  timer: Timer,
  options: ObservePollOptions,
  onObservation: (
    observation: ObserveResult,
    previous: ObserveResult | undefined,
    pollIndex: number
  ) => boolean
): Promise<ObservePollOutcome> {
  const start = timer.now();
  let previous: ObserveResult | undefined;
  let polls = 0;

  while (true) {
    throwIfAborted(options.signal);

    const minTimestamp = previous !== undefined ? toMillis(previous.updatedAt) : start;
    const observation = await observeScreen.execute({
      minTimestamp,
      skipWaitForFresh: false,
      signal: options.signal,
    });
    polls++;
    throwIfAborted(options.signal);

    if (isScreenOff(observation)) {
      return { observation, polls, waitMs: timer.now() - start, stopped: false };
    }

    if (onObservation(observation, previous, polls)) {
      return { observation, polls, waitMs: timer.now() - start, stopped: true };
    }

    previous = observation;

    if (timer.now() - start >= options.timeoutMs) {
      return { observation, polls, waitMs: timer.now() - start, stopped: false };
    }

    await timer.sleep(options.pollMs);
  }
}
