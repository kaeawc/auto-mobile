import type {
  BootedDevice,
  Element,
  ElementBounds,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../models";
import type { TapOnElementOptions } from "../../../models/TapOnElementOptions";
import type { TapBoundsClip, TapViewHierarchy } from "../../../utils/interfaces/TapStrategy";
import type { IosVoiceOverDetector } from "../../accessibility/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../../accessibility/IosVoiceOverDetector";
import { IOSCtrlProxyClient } from "../../observe/ios";
import { clipIosChromeBounds } from "../swipeon/iosChromeInsets";
import { isUsableScreenSize } from "../../utility/ElementGeometry";
import { attachRawViewHierarchy } from "../../utility/viewHierarchySearch";
import type { TapStrategy } from "../../../utils/interfaces/TapStrategy";
import type { FeatureFlagReader } from "../../featureFlags/FeatureFlagService";

/**
 * iOS implementation of {@link TapStrategy}. Filters the response
 * hierarchy via {@link ViewHierarchy.filterOffscreenNodes} (skipped
 * when `screenSize` is missing); reports accessibility state from
 * {@link IosVoiceOverDetector}.
 */
export class IosTapStrategy implements TapStrategy {
  readonly longPressDurationMs = 1000;
  readonly retryTapIfNoChange = false;

  constructor(
    private readonly device: BootedDevice,
    private readonly iosVoiceOverDetector: IosVoiceOverDetector = defaultIosVoiceOverDetector,
    private readonly featureFlags?: FeatureFlagReader,
  ) {}

  prepareViewHierarchyForResponse(
    rawHierarchy: ViewHierarchyResult,
    viewHierarchy: TapViewHierarchy,
    screenSize?: ObserveResult["screenSize"],
  ): ViewHierarchyResult | null {
    if (!screenSize?.width || !screenSize?.height) {
      return null;
    }
    const filtered = viewHierarchy.filterOffscreenNodes(
      rawHierarchy,
      screenSize.width,
      screenSize.height,
    );
    attachRawViewHierarchy(filtered, rawHierarchy);
    return filtered;
  }

  clipNavigationTapBounds(
    bounds: ElementBounds,
    hierarchy: ViewHierarchyResult,
    screenSize: ObserveResult["screenSize"] | undefined,
    elements: readonly Element[],
  ): TapBoundsClip {
    if (!isUsableScreenSize(screenSize)) {
      return { bounds };
    }
    return clipIosChromeBounds({
      bounds,
      hierarchy,
      screen: screenSize,
      elements,
      regions: ["navigation bar"],
      forTapTarget: true,
    });
  }

  async isAccessibilityServiceEnabled(): Promise<boolean> {
    // Resolve lazily so Android paths never touch the iOS singleton.
    const ctrlProxy = IOSCtrlProxyClient.getInstance(this.device);
    // Pass featureFlags so `force-accessibility-mode` / `accessibility-auto-detect`
    // apply to tap detection uniformly with the observe path (#3925).
    // Use the fail-safe tap-bias variant (#6267): an indeterminate probe must
    // route through the VoiceOver activation gesture rather than a plain
    // coordinate touch, unlike the honest `isVoiceOverEnabled` used by
    // toggle-confirmation/state-query consumers.
    return this.iosVoiceOverDetector.isVoiceOverActiveOrUnknown(
      this.device.deviceId,
      ctrlProxy,
      this.featureFlags,
    );
  }

  shouldRunPreTapStability(_options: TapOnElementOptions): boolean {
    return false;
  }
}
