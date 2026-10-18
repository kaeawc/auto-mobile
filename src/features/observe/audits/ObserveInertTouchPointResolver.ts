import { logger } from "../../../utils/logger";
import type { InertTouchPointResolver } from "../../performance/TouchLatencyTracker";
import type { ObserveScreen } from "../interfaces/ObserveScreen";
import { NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { updatedAtToMillis } from "../observeTimestamp";
import { deriveTouchLatencyPoint, findAppWindowBounds } from "./PerformanceAuditor";

/**
 * Production `InertTouchPointResolver`: re-captures a fresh, device-verified
 * view hierarchy through the observe layer and re-derives an inert tap point
 * for the audited app right before each synthetic tap, closing the TOCTOU where
 * a control moves under a previously-selected point between taps (issue #6228).
 *
 * The re-capture asks for `skipWaitForFresh: false` (a genuinely
 * device-verified tree, not an age-based cache hit) and `skipPerformanceAudit`
 * so re-observing from inside the performance audit cannot recurse. Screenshot,
 * back-stack, and accessibility-audit work are skipped as well - only the
 * hierarchy and window attribution matter for deriving the point.
 *
 * `skipWaitForFresh: false` does NOT by itself force a new device capture:
 * `CtrlProxyHierarchy.getLatestHierarchy` only waits for a fresh tree when the
 * cache is absent or already stale, so with no floor it can hand back the SAME
 * cached hierarchy the enclosing audit already saw - defeating the TOCTOU
 * re-validation. So the re-capture also passes a `minTimestamp` strictly newer
 * than the enclosing observation's `updatedAt`, and if the returned tree is not
 * actually newer than that floor the sample is aborted rather than reusing a
 * stale capture (issue #6228).
 */
export class ObserveInertTouchPointResolver implements InertTouchPointResolver {
  constructor(
    private readonly observeScreen: ObserveScreen,
    private readonly appId: string,
    private readonly enclosingUpdatedAt: string | number,
  ) {}

  async resolveInertTouchPoint(): Promise<{ x: number; y: number } | null> {
    try {
      // Force a hierarchy strictly newer than the enclosing observation so the
      // re-validation can't reuse the cached tree the audit already saw.
      const minTimestamp = updatedAtToMillis(this.enclosingUpdatedAt) + 1;
      const fresh = await this.observeScreen.execute({
        // Isolated tracker: sharing the enclosing `PerformanceTracker` would let
        // this nested execute's `getTimings()` close the parent's still-open
        // blocks, corrupting the outer audit's debug timing (issue #6228).
        perf: new NoOpPerformanceTracker(),
        skipWaitForFresh: false,
        minTimestamp,
        skipScreenshot: true,
        skipBackStack: true,
        skipAccessibilityAudit: true,
        skipPerformanceAudit: true,
      });

      // The device-timestamp floor is best-effort in the capture layer (a late
      // push or a sync fallback can still surface an older tree). If the tree we
      // got back is not strictly newer than the enclosing observation, treat it
      // as no fresh point available and abort rather than tapping off a stale
      // capture (issue #6228).
      if (updatedAtToMillis(fresh.updatedAt) < minTimestamp) {
        logger.warn(
          "[PerformanceAudit] Re-observation did not yield a hierarchy newer than the " +
            "enclosing observation; aborting inert-point re-derivation rather than reusing a " +
            "stale capture",
        );
        return null;
      }

      // If the foreground moved off the audited app during the audit, do not
      // derive bounds for the wrong app. Real Android window entries often omit
      // `packageName`, so `findAppWindowBounds` can mis-associate; compare the
      // fresh active-window attribution and abort the sample when it changed
      // (issue #6228).
      if (fresh.activeWindow?.appId !== this.appId) {
        logger.warn(
          `[PerformanceAudit] Foreground changed from ${this.appId} to ` +
            `${fresh.activeWindow?.appId ?? "none"} during audit; aborting inert-point re-derivation`,
        );
        return null;
      }

      const windowBounds = findAppWindowBounds(fresh, this.appId);
      const { touchPoint, skipTouchLatency } = deriveTouchLatencyPoint(windowBounds, fresh);
      if (skipTouchLatency || !touchPoint) {
        return null;
      }
      return touchPoint;
    } catch (error) {
      // Best-effort re-validation: on any capture failure, treat the point as
      // no-longer-verifiable so the tracker aborts the sample rather than
      // tapping a stale point (issue #6228).
      logger.warn(`[PerformanceAudit] Failed to re-derive inert touch point: ${error}`);
      return null;
    }
  }
}
