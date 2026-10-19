import type { GfxMetrics, ObserveResult } from "../../models";
import { hierarchyFingerprint } from "../../utils/hierarchyFingerprint";
import { logger } from "../../utils/logger";
import type { PerformanceTracker } from "../../utils/PerformanceTracker";
import type { ObservedActionResult, ObservedEnvelope } from "./observedInteractionTypes";

// Pure post-read stages of the observed-interaction pipeline (see BaseVisualChange).

/**
 * The block's own result as `observedInteraction` returns it. Its declared result type `R` is
 * trusted: blocks also return bare `{ success: false, error }` failures that lack `R`'s required
 * fields. The one place that trust is stated, shared by the pipeline and by tests that replace
 * the surrounding observation loop.
 */
export function asObservedResult<R extends ObservedActionResult>(
  result: R | ObservedActionResult,
): R & ObservedEnvelope {
  return result as R & ObservedEnvelope;
}

/** Retry unless the read errored (retrying only adds latency) or is fresh and changed. */
export function observationNeedsRetry(
  observation: ObserveResult,
  minTimestamp: number,
  changeExpected: boolean,
  previousHash: ReturnType<typeof hierarchyFingerprint>,
): boolean {
  if (observation.viewHierarchy?.hierarchy?.error) {
    return false;
  }
  if (minTimestamp > 0 && !(observation.freshness?.isFresh ?? true)) {
    return true;
  }
  if (!changeExpected) {
    return false;
  }
  const currentHash = hierarchyFingerprint(observation.viewHierarchy);
  return !!previousHash && !!currentHash && previousHash === currentHash;
}

export function hasUsableHierarchy(observation: ObserveResult): boolean {
  return Boolean(observation.viewHierarchy && !observation.viewHierarchy.hierarchy.error);
}

export function warnStillStale(observation: ObserveResult, minTimestamp: number): void {
  const warning =
    minTimestamp > 0
      ? "Observation may be stale after interaction"
      : "Observation may not reflect expected visual change";
  // Spreading a possibly-undefined `freshness` used to drop the required
  // `isFresh`. When no freshness was computed at all, the honest value is
  // `false` (not confirmed fresh) — this only runs because the
  // observation still looks stale/unchanged after every retry.
  observation.freshness = observation.freshness
    ? { ...observation.freshness, warning }
    : { isFresh: false, warning };
  logger.warn(`[BaseVisualChange] ${warning}`);
}

/** Derive `success` from the visual-change verdict, never overriding an explicit block failure. */
export function applySuccessVerdict(
  result: ObservedActionResult & ObservedEnvelope,
  visualChange: boolean | null,
): void {
  if (visualChange !== null) {
    if (result.success !== false) {
      result.success = visualChange;
      if (!visualChange) {
        result.error = "No visual change observed";
      }
    }
    return;
  }
  if (result && "error" in result && result.error !== undefined) {
    result.success = false;
  } else if (result && (!("success" in result) || result.success === undefined)) {
    result.success = true;
  }
}

export function attachTelemetry(
  observation: ObserveResult,
  gfxMetrics: GfxMetrics | null | undefined,
  perf: PerformanceTracker,
): void {
  if (gfxMetrics) {
    observation.gfxMetrics = gfxMetrics;
  }
  const timings = perf.isEnabled() ? perf.getTimings() : undefined;
  if (timings) {
    observation.perfTiming = timings;
  }
}
