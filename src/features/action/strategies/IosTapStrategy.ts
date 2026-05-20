import type {
  BootedDevice,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../models";
import type { TapOnElementOptions } from "../../../models/TapOnElementOptions";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { IOSCtrlProxy } from "../../observe/ios";
import type { ViewHierarchy } from "../../observe/ViewHierarchy";
import type { IosVoiceOverDetector } from "../../../utils/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../../../utils/IosVoiceOverDetector";
import { attachRawViewHierarchy } from "../../../utils/viewHierarchySearch";
import type { TapStrategy } from "../../../utils/interfaces/TapStrategy";

/**
 * iOS implementation of {@link TapStrategy}.
 *
 * Hierarchy filtering uses {@link ViewHierarchy.filterOffscreenNodes}
 * (which needs `screenSize`); accessibility detection consults the
 * shared {@link IosVoiceOverDetector} for VoiceOver state. Android-only
 * recovery hooks (pre-tap stability, retry-if-no-change) are no-ops
 * on iOS.
 */
export class IosTapStrategy implements TapStrategy {
  private static readonly LONG_PRESS_DURATION_MS = 1000;

  constructor(
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

  async isAccessibilityServiceEnabled(
    device: BootedDevice,
    _adb: AdbExecutor,
    iosCtrlProxy: IOSCtrlProxy
  ): Promise<boolean> {
    return this.iosVoiceOverDetector.isVoiceOverEnabled(device.deviceId, iosCtrlProxy);
  }

  shouldRunPreTapStability(_options: TapOnElementOptions): boolean {
    return false;
  }

  shouldRetryTapIfNoChange(): boolean {
    return false;
  }

  getLongPressDurationMs(): number {
    return IosTapStrategy.LONG_PRESS_DURATION_MS;
  }
}
