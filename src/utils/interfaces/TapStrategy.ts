import type { ViewHierarchyResult, ObserveResult, Element, ElementBounds } from "../../models";
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

/** Result of clipping a tap target's bounds to the area a tap can reach. */
export interface TapBoundsClip {
  bounds: ElementBounds | null;
  coveredBy?: string;
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
   * Clip a tap target to the area not covered by platform navigation chrome.
   * Platforms without such chrome return `{ bounds }` unchanged.
   */
  clipNavigationTapBounds(
    bounds: ElementBounds,
    hierarchy: ViewHierarchyResult,
    screenSize: ObserveResult["screenSize"] | undefined,
    elements: readonly Element[],
  ): TapBoundsClip;

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

  /**
   * Whether post-tap effect derivation waits out the activity-transition window and settles
   * hierarchy-only changes before concluding what a tap did (Android only).
   */
  readonly settlesPostTapEffects: boolean;

  /** Whether tapping a disabled element adds a "may have no effect" warning (Android only). */
  readonly warnsOnDisabledTarget: boolean;

  /** Whether a failed post-tap focus check is re-polled until focus settles (iOS only). */
  readonly settlesFocusChangeAfterTap: boolean;

  /** Whether a freshly captured hierarchy is checked for a display change (Android only). */
  readonly checksRefreshedDisplay: boolean;

  /** Whether a matched element may be promoted to its clickable ancestor (Android only). */
  readonly promotesTapTargetToAncestor: boolean;

  /** Whether a keyboard occlusion during a focus tap is rethrown for IME recovery (Android only). */
  readonly rethrowsKeyboardOcclusion: boolean;

  /**
   * Restamp the rotation of an observation whose hierarchy was just re-captured. Platforms
   * that do not derive observation rotation from the hierarchy leave it untouched.
   */
  applyRefreshedObservationRotation(
    observation: ObserveResult,
    hierarchyRotation: number | undefined,
  ): void;

  /** Default long-press duration in milliseconds. */
  readonly longPressDurationMs: number;
}
