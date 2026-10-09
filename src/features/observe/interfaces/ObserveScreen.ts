import type { HierarchyCaptureRequest } from "../HierarchyCapture";
import type { ObserveResult } from "../../../models";
import type { ViewHierarchyQueryOptions } from "../../../models/ViewHierarchyQueryOptions";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { ScreenshotMode } from "../automaticScreenshotPolicy";
import type { ObserveScreenshotOptions } from "../screenshot/screenshotOptions";

/** Options for a session-free device observation. */
export interface DeviceReadOptions {
  /** Require a fresh screenshot; capture failure throws instead of using cached evidence. */
  requireFreshScreenshot?: boolean;
  /** Bound aggregate display reads by the remaining request budget in milliseconds. */
  timeoutMs?: number;
}

export interface ObserveScreenExecuteOptions {
  /** Internal focused-field read: capture hierarchy and derive focus, without device state or audits. */
  hierarchyOnly?: boolean;
  /** A session-free read: collect the normal result without advancing owner-visible state. */
  observerMode?: boolean;
  queryOptions?: ViewHierarchyQueryOptions;
  perf?: PerformanceTracker;
  /** Explicit internal capture policy, including the collector fallback wait. */
  freshness?: HierarchyCaptureRequest["freshness"];
  /** Bounds an explicitly requested hierarchy capture. */
  timeoutMs?: number;
  skipWaitForFresh?: boolean;
  /** Re-extract Android cache hits (including known wrong-window trees). Off by default. */
  requireFreshExtraction?: boolean;
  minTimestamp?: number;
  signal?: AbortSignal;
  skipBackStack?: boolean;
  skipScreenshot?: boolean;
  /** Defer caching an intermediate observation until its caller selects a result. */
  skipCache?: boolean;
  /** Per-call override; omitted reads the env and persisted flag. */
  screenshot?: ScreenshotMode;
  screenshotOptions?: ObserveScreenshotOptions;
  /** Physical panel key or role; "active" follows focus, Android "all" adds panel observations. */
  display?: string;
  /** Skip screenshot-dependent accessibility auditing for intermediate observations. */
  skipAccessibilityAudit?: boolean;
  /**
   * Skip the performance audit for this observation. Set when re-observing from
   * inside the performance audit itself (per-tap inert-point re-validation,
   * issue #6228) so the nested capture cannot recurse back into the auditor.
   */
  skipPerformanceAudit?: boolean;
  /** Skip recomposition processing for an intermediate observation. */
  skipRecompositionTracking?: boolean;
  /** Poll callers own retries; do not add a second hierarchy read inside their poll. */
  skipStaleWindowRecovery?: boolean;
  /**
   * Explicit observe: when an Android hierarchy is still served from CtrlProxy's push cache
   * without a device read, replace it with one synchronous extraction so the published
   * freshness is verified. Off by default; costs no read when the tree was already verified.
   */
  verifyCachedHierarchy?: boolean;
}

/**
 * Interface for observing device screen state.
 */
export interface ObserveScreen {
  /**
   * Execute the observe command to capture screen state.
   * Collects view hierarchy, screen size, system insets, and other device state.
   */
  execute(options?: ObserveScreenExecuteOptions): Promise<ObserveResult>;

  /**
   * Capture a screenshot without taking another hierarchy observation.
   *
   * Optional while fakes and narrow test doubles migrate. The production
   * implementation supplies it for automatic action/waitFor evidence capture.
   */
  captureScreenshot?(
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    observation?: ObserveResult,
    screenshot?: ScreenshotMode,
    screenshotOptions?: ObserveScreenshotOptions,
  ): Promise<void>;

  /**
   * Run the configured accessibility audit for an already-collected observation
   * without capturing a screenshot.
   */
  runAccessibilityAudit?(observation: ObserveResult, perf?: PerformanceTracker): Promise<void>;

  /**
   * Process recomposition metrics for an already-collected observation without
   * re-observing. Used to charge settle-loop side effects to its adopted
   * terminal capture exactly once after intermediate polls skipped them (#6932).
   */
  processRecomposition?(observation: ObserveResult, perf?: PerformanceTracker): Promise<void>;

  /** Attach a skipped Android back stack; true requests one full poll to reconcile activity attribution. */
  collectDeferredBackStack?(
    observation: ObserveResult,
    options?: { signal?: AbortSignal },
  ): Promise<boolean | void>;

  /** Capture the cache generation at poll start for the deferred write's stale-write fence. */
  captureCacheGeneration?(): number;

  /** Persist the selected poll result with its observation-start generation and host time. */
  cacheObserveResult?(
    observation: ObserveResult,
    generation?: number,
    cachedAt?: number,
  ): Promise<void>;

  /**
   * Fetch raw (unfiltered) view hierarchy from the device and attach it to an existing
   * ObserveResult. Safe to call after execute() — does not re-observe the screen.
   * @param result - Existing observe result to augment with raw hierarchy data
   * @param signal - Optional abort signal
   */
  appendRawViewHierarchy(result: ObserveResult, signal?: AbortSignal): Promise<void>;

  /**
   * Get the most recent cached observe result from memory or disk cache.
   * @returns Promise with the most recent cached observe result
   */
  getMostRecentCachedObserveResult(): Promise<ObserveResult>;
}
