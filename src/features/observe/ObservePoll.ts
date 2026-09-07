import type { ObserveResult } from "../../models";
import type { ObserveScreen } from "./interfaces/ObserveScreen";
import { Timer } from "../../utils/SystemTimer";
import { throwIfAborted } from "../../utils/toolUtils";
import { updatedAtToMillis } from "./observeTimestamp";

/**
 * Shared observe poll loop for the settle / wait-for-condition primitives
 * (issue #4389). Both are the same loop with a different stop test, so the
 * monotonic-freshness and budget logic — the subtle correctness — lives here
 * once.
 */
export interface ObservePollOptions {
  /**
   * Hard budget in ms. Mandatory: the loop stops scheduling polls once elapsed
   * time reaches it. It can overshoot by up to one `pollMs` plus one observe, so
   * `waitMs` may exceed `timeoutMs` slightly — the budget bounds the loop, it is
   * not an exact deadline.
   */
  timeoutMs: number;
  /** Poll interval in ms between observations. */
  pollMs: number;
  signal?: AbortSignal;
  /**
   * Optional seed for the monotonic `minTimestamp` floor, in the SAME clock
   * domain the floor lives in end-to-end: the device-authored `updatedAt`
   * (issue #6284). Supply a device-clock-domain timestamp (e.g. the capture
   * that triggered a post-tap settle) so the FIRST poll already requires a
   * read at least as new as that capture. Omit it for the default path: the
   * first poll then takes the freshest capture available and the floor is
   * seeded from THAT observation's own device timestamp.
   *
   * Never pass a host-clock timestamp here. An Android device clock trailing
   * the daemon (issue #5377) would make every genuinely-fresh device capture
   * look older than a host-domain floor, so the freshness gate
   * (`updatedAt >= minTimestamp`) would reject fresh reads and the loop would
   * burn its whole budget instead of settling promptly.
   */
  initialMinTimestampMs?: number;
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
 * Screen-off is Android-only (`wakefulness`). iOS observations carry no
 * wakefulness signal, so they read as awake — the loop stays cross-platform.
 */
function isScreenOff(observation: ObserveResult): boolean {
  return observation.wakefulness === "Asleep";
}

/**
 * Poll `observeScreen` until `onObservation` returns true or the budget expires.
 *
 * Freshness: the `minTimestamp` floor lives in ONE clock domain end-to-end —
 * the device-authored `updatedAt` (issue #6284). It is seeded from
 * `initialMinTimestampMs` when the caller supplies a device-domain floor,
 * otherwise left unseeded so the first poll takes the freshest capture and the
 * floor is seeded from that observation's own device timestamp. It is then only
 * ever RAISED (`Math.max`), never lowered: a stale/cached capture returned by a
 * timed-out sub-poll carries an older `updatedAt`, and flooring on it naively
 * would drop the floor and let the same stale hash re-satisfy a caller's
 * predicate. Each poll passes `skipWaitForFresh: false`, and the device
 * freshness gate is inclusive (`updatedAt >= minTimestamp`) — "at least as new",
 * not "strictly newer" — so it steers each poll toward the latest available
 * capture without forcing a full fresh-wait on a static screen. On a screen-off
 * (Android) capture the loop fast-fails rather than burning the budget against a
 * dark screen.
 */
export async function pollObserveUntil(
  observeScreen: ObserveScreen,
  timer: Timer,
  options: ObservePollOptions,
  onObservation: (
    observation: ObserveResult,
    previous: ObserveResult | undefined,
    pollIndex: number,
  ) => boolean,
): Promise<ObservePollOutcome> {
  const start = timer.now();
  let previous: ObserveResult | undefined;
  let polls = 0;
  // Monotonic device-clock-domain floor (issue #6284). `undefined` until the
  // caller seeds it or the first observation seeds it; `undefined`/0 means "no
  // floor" to `ObserveScreen.execute` (it coerces `minTimestamp ?? 0` and only
  // treats `> 0` as a real constraint), so an unseeded first poll accepts the
  // freshest capture available.
  let floor = options.initialMinTimestampMs;

  while (true) {
    throwIfAborted(options.signal);

    const observation = await observeScreen.execute({
      minTimestamp: floor ?? 0,
      skipWaitForFresh: false,
      signal: options.signal,
      // Polls are intermediate state only. Public callers that opt into
      // automatic evidence capture it once after this loop completes.
      skipScreenshot: true,
      skipAccessibilityAudit: true,
    });
    polls++;
    throwIfAborted(options.signal);

    // Raise the floor to this capture's device timestamp (seeding it on the
    // first poll when unseeded). `Math.max` guarantees a stale/cached capture
    // can never LOWER the floor for a later poll.
    const observedMs = updatedAtToMillis(observation.updatedAt);
    floor = floor === undefined ? observedMs : Math.max(floor, observedMs);

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
