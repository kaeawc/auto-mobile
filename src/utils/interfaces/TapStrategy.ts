import type { ViewHierarchyResult, ObserveResult } from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
/** Hierarchy transformations required by platform tap strategies. */
export interface TapViewHierarchy {
  filterViewHierarchy(hierarchy: ViewHierarchyResult): ViewHierarchyResult;
  filterOffscreenNodes(
    hierarchy: ViewHierarchyResult,
    width: number,
    height: number,
    margin?: number,
  ): ViewHierarchyResult;
}

/**
 * Platform-specific surface used by {@link TapOnElement} to keep its
 * top-level flow free of `device.platform === ...` branches.
 *
 * Implemented by `AndroidTapStrategy` and `IosTapStrategy`; selected
 * once in the `TapOnElement` constructor via `createTapStrategy`. Each
 * strategy captures its platform dependencies (device, adb, detector,
 * …) at construction so call sites never need to thread them through.
 */
export interface TapStrategy {
  /**
   * Post-process a raw view hierarchy for inclusion in the tap result.
   * Returns the filtered hierarchy, or `null` when filtering does not
   * apply — in which case the caller uses the raw hierarchy unchanged.
   */
  prepareViewHierarchyForResponse(
    rawHierarchy: ViewHierarchyResult,
    viewHierarchy: TapViewHierarchy,
    screenSize?: ObserveResult["screenSize"],
  ): ViewHierarchyResult | null;

  /**
   * Whether the platform's accessibility service (TalkBack / VoiceOver)
   * is currently active.
   */
  isAccessibilityServiceEnabled(onWarning?: (warning: string) => void): Promise<boolean>;

  /**
   * Whether `TapOnElement` should run the Android-only pre-tap stability
   * loop. iOS returns `false` regardless of `options.preTapStability`.
   */
  shouldRunPreTapStability(options: TapOnElementOptions): boolean;

  /** Re-tap when the view hierarchy hash is unchanged after a tap. */
  readonly retryTapIfNoChange: boolean;

  /** Default long-press duration in milliseconds. */
  readonly longPressDurationMs: number;
}
