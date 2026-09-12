import type { ObserveResult, ViewHierarchyResult } from "../models";
import type { Timer } from "./SystemTimer";
import { logger } from "./logger";

/**
 * Structural fingerprint of an observed hierarchy. Two observations of a
 * stationary screen produce the same fingerprint; a mid-scroll frame does not.
 */
export const computeHierarchyFingerprint = (viewHierarchy?: ViewHierarchyResult): string => {
  if (!viewHierarchy?.hierarchy) {
    return "";
  }
  return JSON.stringify(viewHierarchy.hierarchy);
};

export interface ScrollIdleOptions {
  /** Re-observe the screen. Must return a fresh (non-cached) observation. */
  observe: () => Promise<ObserveResult>;
  timer: Timer;
  /** Upper bound on the whole idle check; the latest observation is returned on expiry. */
  maxWaitMs: number;
  pollIntervalMs: number;
  /** Log prefix identifying the caller, e.g. `[SwipeOn]`. */
  logPrefix: string;
  signal?: AbortSignal;
}

/**
 * Wait for a scroll animation to settle before the caller inspects the
 * hierarchy. A post-swipe observation can reflect a mid-scroll position (the
 * accessibility service may return a hierarchy captured before the fling
 * decelerates to rest), so poll until two consecutive observations carry the
 * same fingerprint rather than sleeping for a fixed guess.
 *
 * Returns the settled observation, or the most recent one if `maxWaitMs`
 * elapses first.
 */
export const waitForScrollIdle = async (
  currentObservation: ObserveResult,
  options: ScrollIdleOptions,
): Promise<ObserveResult> => {
  const { observe, timer, maxWaitMs, pollIntervalMs, logPrefix, signal } = options;
  if (!currentObservation.viewHierarchy) {
    return currentObservation;
  }
  const startTime = timer.now();
  let previousFingerprint = computeHierarchyFingerprint(currentObservation.viewHierarchy);
  let latestObservation = currentObservation;

  while (timer.now() - startTime < maxWaitMs) {
    signal?.throwIfAborted();
    const newObservation = await observe();
    if (!newObservation.viewHierarchy) {
      break;
    }
    const newFingerprint = computeHierarchyFingerprint(newObservation.viewHierarchy);
    if (newFingerprint === previousFingerprint) {
      logger.info(`${logPrefix} Scroll settled after ${timer.now() - startTime}ms idle check`);
      return newObservation;
    }
    logger.info(
      `${logPrefix} Scroll still settling (elapsed=${timer.now() - startTime}ms), retrying in ${pollIntervalMs}ms`,
    );
    previousFingerprint = newFingerprint;
    latestObservation = newObservation;
    signal?.throwIfAborted();
    await timer.sleep(pollIntervalMs);
  }

  logger.info(`${logPrefix} Scroll idle check reached ${maxWaitMs}ms limit, proceeding`);
  return latestObservation;
};
