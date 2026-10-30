import type { Element, ScreenIdentity, ViewHierarchyResult } from "../../../models";
import type { ViewHierarchyQueryOptions } from "../../../models/ViewHierarchyQueryOptions";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { ViewHierarchyReadRequest } from "../hierarchyReadArgs";

/** Internal hierarchy read policy; numeric budgets remain supported for existing callers. */
export interface HierarchyReadOptions {
  timeoutMs?: number;
  /** Re-extract an Android cache hit; a positive floor also requires independent freshness evidence. */
  requireFreshExtraction?: boolean;
}

/** The narrow read seam for consumers that only read the hierarchy. */
export interface ViewHierarchyRequestReader {
  getViewHierarchy(
    queryOptions?: ViewHierarchyQueryOptions,
    request?: ViewHierarchyReadRequest,
  ): Promise<ViewHierarchyResult>;
}

/**
 * Interface for retrieving and managing view hierarchy data.
 */
export interface ViewHierarchy {
  /**
   * Return the latest app-provided (AutoMobile SDK) navigation identity, if
   * this hierarchy reader has one. Optional so hierarchy-only fakes do not need an SDK seam.
   */
  getScreenIdentity?(
    applicationId?: string,
    capturedAt?: number,
  ): ScreenIdentity | undefined | Promise<ScreenIdentity | undefined>;

  /**
   * Retrieve the view hierarchy of the current screen.
   * @param queryOptions - Optional query options for targeted element retrieval
   * @param request - Optional performance tracker, freshness floor (`skipWaitForFresh`,
   *   `minTimestamp`), abort signal and read policy; `timeoutMs` bounds both the fresh-data
   *   wait and the sync fallback so a caller with its own deadline cannot be blocked past it
   * @returns Promise with parsed view hierarchy
   */
  getViewHierarchy(
    queryOptions?: ViewHierarchyQueryOptions,
    request?: ViewHierarchyReadRequest,
  ): Promise<ViewHierarchyResult>;

  /**
   * Configure recomposition tracking for Compose UI debugging.
   * @param enabled - Whether to enable recomposition tracking
   * @param perf - Optional performance tracker
   */
  configureRecompositionTracking(
    enabled: boolean,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<void>;

  /**
   * Find the focused element in the view hierarchy.
   * @param viewHierarchy - The view hierarchy to search
   * @returns The focused element or null if none found
   */
  findFocusedElement(viewHierarchy: any): Element | null;

  /**
   * Find the accessibility-focused element (TalkBack cursor position) in the view hierarchy.
   * @param viewHierarchy - The view hierarchy to search
   * @returns The accessibility-focused element or null if none found
   */
  findAccessibilityFocusedElement(viewHierarchy: any): Element | null;

  /**
   * Filter out completely offscreen nodes from the view hierarchy.
   * @param viewHierarchy - The view hierarchy to filter
   * @param screenWidth - Screen width in pixels
   * @param screenHeight - Screen height in pixels
   * @param margin - Extra margin around screen to keep near-visible elements (default 100px)
   * @returns Filtered view hierarchy with offscreen nodes removed
   */
  filterOffscreenNodes(
    viewHierarchy: any,
    screenWidth: number,
    screenHeight: number,
    margin?: number,
  ): any;

  /**
   * Execute raw uiautomator dump to get XML hierarchy (Android only).
   * Optional — not all implementations support this.
   * @returns Promise with raw XML string
   */
  executeUiAutomatorDump?(): Promise<string>;
}
