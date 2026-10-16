import type { DeviceLockState } from "../../models/DeviceLockState";
import type { ObserveResult } from "../../models/ObserveResult";
import type { StaleDisplayDetails } from "../observe/StaleDisplayError";
import type { TapEffect } from "../../models/TapOnElementResult";
import type { ViewHierarchyQueryOptions } from "../../models/ViewHierarchyQueryOptions";
import type { PerformanceTracker } from "../../utils/PerformanceTracker";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import type { ProgressCallback } from "./BaseVisualChange";

/**
 * What `observedInteraction` reads from the result its block returns. Everything else on the
 * result is carried through untouched. `success` may be missing: the pipeline then settles it
 * from the observation (`true` unless an `error` was set).
 */
export interface ObservedActionResult {
  success?: boolean;
  error?: string;
  /** The action took effect in part, e.g. a boomerang whose return leg failed after the forward swipe. */
  partialApplication?: boolean;
  /** `false` marks a failure no retry can fix; unconfirmed iOS text uses it. */
  retryable?: boolean;
  /** Set when the display changed under the action. */
  staleDisplay?: StaleDisplayDetails;
}

/**
 * What `observedInteraction` adds to the block's result. `observation` is absent only when an
 * unconfirmed, non-retryable iOS failure returns before any post-action read.
 */
export interface ObservedEnvelope {
  observation?: ObserveResult;
  /** Set when the action was bound to a display panel. */
  effect?: TapEffect;
  /** Pre-action lock state, attached when an Android keyguard was up (#4280). */
  deviceLock?: DeviceLockState;
  deviceLockWarning?: string;
}

export interface ObservedChangeOptions {
  changeExpected: boolean;
  /** Retire pre-action trees before the post-action capture, including partial dispatch failures. */
  foregroundAppMayChange?: boolean;
  /**
   * A non-retryable failed block that reports `partialApplication` (a boomerang whose return leg
   * failed after the forward swipe landed) still gets the post-action observation on iOS, as on
   * Android, so the caller sees where the content ended up. Unconfirmed text, which also reports
   * `retryable: false`, keeps returning before any post-action read.
   */
  observePartialApplication?: boolean;
  /** Hardware navigation and URL dispatch do not resolve coordinates from the prior tree. */
  usesObservationForResolution?: boolean;
  /**
   * The block resolves its target from a selector against the pre-action read, never from
   * coordinates the caller chose. When the caller last saw an older display generation, an
   * unscoped action (no `display`, `previousObservation` or `skipPreviousObserve`) takes one
   * fresh read and proceeds only if that read is at the current display revision, instead of
   * refusing every retry until a manual observe (#9847). A `previousObservation` the action read
   * itself during this call stands in for that read when it was recorded at the current display
   * revision, so the block's coordinates come from it (#10710). Raw-coordinate actions must not
   * set it.
   */
  resolvesTargetFromRead?: boolean;
  /** Bind pre/post captures to the panel prepared by the action. */
  display?: string;
  previousObservation?: ObserveResult;
  /** Per-call capture seam for actions that must validate every post-action poll. */
  postActionObserveScreen?: ObserveScreen;
  timeoutMs?: number;
  packageName?: string;
  progress?: ProgressCallback;
  tolerancePercent?: number;
  queryOptions?: ViewHierarchyQueryOptions;
  perf?: PerformanceTracker;
  /** Internal gesture coordinates come from the current observation inside the block.
   * Skips only the caller-revision fence; preparing and dispatch fences remain.
   */
  skipCallerDisplayFence?: boolean;
  skipPreviousObserve?: boolean;
  skipUiStability?: boolean;
  observationTimestampProvider?: () => number | undefined;
  /**
   * Host-clock time (`timer.now()`) at which the action's input was dispatched.
   * Converted to the device clock with the skew measured once at action start
   * (`actionStartTime` minus the host time of that read), so no second device
   * read is needed after the input (#9879). Ignored when
   * `observationTimestampProvider` yields a value.
   */
  observationHostTimestampProvider?: () => number | undefined;
  overrideMinTimestamp?: number;
  signal?: AbortSignal;
  deferPredictionOutcome?: boolean;
  deferPostActionScreenshot?: boolean;
  predictionContext?: {
    toolName: string;
    toolArgs: Record<string, unknown>;
  };
}
