import type { ObserveResult } from "../../../models";
import type { ViewHierarchyQueryOptions } from "../../../models/ViewHierarchyQueryOptions";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";

export interface ObserveScreenExecuteOptions {
  queryOptions?: ViewHierarchyQueryOptions;
  perf?: PerformanceTracker;
  skipWaitForFresh?: boolean;
  minTimestamp?: number;
  signal?: AbortSignal;
  skipBackStack?: boolean;
  skipScreenshot?: boolean;
  /** Skip screenshot-dependent accessibility auditing for intermediate observations. */
  skipAccessibilityAudit?: boolean;
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
