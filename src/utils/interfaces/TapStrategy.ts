import type { ViewHierarchyResult, ObserveResult, BootedDevice } from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { AdbExecutor } from "../android-cmdline-tools/interfaces/AdbExecutor";
import type { IOSCtrlProxy } from "../../features/observe/ios";
import type { ViewHierarchy } from "../../features/observe/ViewHierarchy";

/**
 * Platform-specific surface used by {@link TapOnElement} to keep its
 * top-level flow free of `device.platform === ...` branches.
 *
 * Implemented by `AndroidTapStrategy` and `IosTapStrategy`. The
 * concrete strategy is selected once in the `TapOnElement` constructor
 * based on `device.platform` so call sites never need to re-check.
 *
 * The interface is deliberately narrow: it covers exactly the four
 * platform-divergent concerns inside `TapOnElement` (response hierarchy
 * filtering, accessibility-service detection, Android-only pre-tap
 * stability/retry-if-no-change gating, and the default long-press
 * duration). Anything richer would leak Android- or iOS-specific
 * concepts into the shared contract.
 */
export interface TapStrategy {
  /**
   * Post-process a raw view hierarchy for inclusion in the tap result.
   *
   * Android collapses the tree via `filterViewHierarchy`; iOS removes
   * off-screen nodes via `filterOffscreenNodes` (which needs the
   * `screenSize`, so iOS skips the filter when `screenSize` is
   * unavailable). The method returns the filtered hierarchy, or `null`
   * when filtering is not applicable — in which case the caller should
   * use the raw hierarchy unchanged.
   */
  prepareViewHierarchyForResponse(
    rawHierarchy: ViewHierarchyResult,
    viewHierarchy: ViewHierarchy,
    screenSize?: ObserveResult["screenSize"]
  ): ViewHierarchyResult | null;

  /**
   * Whether the platform's accessibility service (TalkBack on Android,
   * VoiceOver on iOS) is currently active. Used to route the tap
   * through the appropriate accessibility-aware code path.
   */
  isAccessibilityServiceEnabled(
    device: BootedDevice,
    adb: AdbExecutor,
    iosCtrlProxy: IOSCtrlProxy
  ): Promise<boolean>;

  /**
   * Whether `TapOnElement` should run the Android-only pre-tap stability
   * loop (re-find the element on a refreshed hierarchy until bounds
   * settle). iOS returns `false` regardless of the option.
   */
  shouldRunPreTapStability(options: TapOnElementOptions): boolean;

  /**
   * Whether `TapOnElement` should re-tap when the view hierarchy hash
   * is unchanged after the initial tap (Android-only ghost-tap recovery).
   * iOS returns `false`.
   */
  shouldRetryTapIfNoChange(): boolean;

  /**
   * Default long-press duration in milliseconds when the caller has not
   * supplied an explicit duration. Android: 500ms; iOS: 1000ms.
   */
  getLongPressDurationMs(): number;
}
