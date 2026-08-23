import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../models";
import type { TapOnElementOptions } from "../../../models/TapOnElementOptions";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ViewHierarchy } from "../../observe/ViewHierarchy";
import type { AccessibilityDetector } from "../../../utils/interfaces/AccessibilityDetector";
import { accessibilityDetector as defaultAccessibilityDetector } from "../../../utils/AccessibilityDetector";
import { attachRawViewHierarchy } from "../../../utils/viewHierarchySearch";
import type { TapStrategy } from "../../../utils/interfaces/TapStrategy";
import type { FeatureFlagService } from "../../featureFlags/FeatureFlagService";

/**
 * Android implementation of {@link TapStrategy}. Filters the response
 * hierarchy via {@link ViewHierarchy.filterViewHierarchy} and reports
 * accessibility state from {@link AccessibilityDetector} (TalkBack).
 */
export class AndroidTapStrategy implements TapStrategy {
  readonly longPressDurationMs = 500;
  readonly retryTapIfNoChange = true;

  constructor(
    private readonly device: BootedDevice,
    private readonly adb: AdbExecutor,
    private readonly accessibilityDetector: AccessibilityDetector = defaultAccessibilityDetector,
    private readonly featureFlags?: FeatureFlagService,
  ) {}

  prepareViewHierarchyForResponse(
    rawHierarchy: ViewHierarchyResult,
    viewHierarchy: ViewHierarchy,
    _screenSize?: ObserveResult["screenSize"],
  ): ViewHierarchyResult | null {
    const filtered = viewHierarchy.filterViewHierarchy(rawHierarchy);
    attachRawViewHierarchy(filtered, rawHierarchy);
    return filtered;
  }

  async isAccessibilityServiceEnabled(): Promise<boolean> {
    // Pass featureFlags so `force-accessibility-mode` / `accessibility-auto-detect`
    // apply to tap detection uniformly with the observe path (#3925).
    const method = await this.accessibilityDetector.detectMethod(
      this.device.deviceId,
      this.adb,
      this.featureFlags,
    );
    return method === "talkback";
  }

  shouldRunPreTapStability(options: TapOnElementOptions): boolean {
    return Boolean(options.preTapStability);
  }
}
