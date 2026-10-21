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

  /** Warn when the matched element reports itself as disabled (Android only). */
  readonly warnsOnDisabledElement: boolean;

  /** Wait out the activity-transition window before concluding a tap changed nothing. */
  readonly settlesPostTapChange: boolean;

  /** Re-check the display generation after a fresh hierarchy capture. */
  readonly verifiesRefreshedDisplay: boolean;

  /** Promote a matched node to its nearest clickable ancestor as the tap target. */
  readonly promotesClickableAncestor: boolean;

  /** Whether a failed post-tap focus check is re-polled until focus settles (iOS only). */
  readonly settlesFocusChangeAfterTap: boolean;

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
