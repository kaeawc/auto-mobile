import type {
  BootedDevice,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../models";
import type { TapOnElementOptions } from "../../../models/TapOnElementOptions";
import type { ViewHierarchy } from "../../observe/ViewHierarchy";
import type { IosVoiceOverDetector } from "../../../utils/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../../../utils/IosVoiceOverDetector";
import { IOSCtrlProxyClient } from "../../observe/ios";
import { attachRawViewHierarchy } from "../../../utils/viewHierarchySearch";
import type { TapStrategy } from "../../../utils/interfaces/TapStrategy";

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
    private readonly iosVoiceOverDetector: IosVoiceOverDetector = defaultIosVoiceOverDetector
  ) {}

  prepareViewHierarchyForResponse(
    rawHierarchy: ViewHierarchyResult,
    viewHierarchy: ViewHierarchy,
    screenSize?: ObserveResult["screenSize"]
  ): ViewHierarchyResult | null {
    if (!screenSize?.width || !screenSize?.height) {
      return null;
    }
    const filtered = viewHierarchy.filterOffscreenNodes(
      rawHierarchy,
      screenSize.width,
      screenSize.height
    );
    attachRawViewHierarchy(filtered, rawHierarchy);
    return filtered;
  }

  async isAccessibilityServiceEnabled(): Promise<boolean> {
    // Resolve lazily so Android paths never touch the iOS singleton.
    const ctrlProxy = IOSCtrlProxyClient.getInstance(this.device);
    return this.iosVoiceOverDetector.isVoiceOverEnabled(this.device.deviceId, ctrlProxy);
  }

  shouldRunPreTapStability(_options: TapOnElementOptions): boolean {
    return false;
  }
}
