import type {
  BootedDevice,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../models";
import type { TapOnElementOptions } from "../../../models/TapOnElementOptions";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { IOSCtrlProxy } from "../../observe/ios";
import type { ViewHierarchy } from "../../observe/ViewHierarchy";
import type { AccessibilityDetector } from "../../../utils/interfaces/AccessibilityDetector";
import { accessibilityDetector as defaultAccessibilityDetector } from "../../../utils/AccessibilityDetector";
import { attachRawViewHierarchy } from "../../../utils/viewHierarchySearch";
import type { TapStrategy } from "../../../utils/interfaces/TapStrategy";

/**
 * Android implementation of {@link TapStrategy}.
 *
 * Hierarchy filtering uses {@link ViewHierarchy.filterViewHierarchy};
 * accessibility detection consults the shared {@link AccessibilityDetector}
 * for TalkBack state. Pre-tap stability and retry-if-no-change are
 * Android-specific recovery flows so they are gated on here.
 */
export class AndroidTapStrategy implements TapStrategy {
  private static readonly LONG_PRESS_DURATION_MS = 500;

  constructor(
    private readonly accessibilityDetector: AccessibilityDetector = defaultAccessibilityDetector
  ) {}

  prepareViewHierarchyForResponse(
    rawHierarchy: ViewHierarchyResult,
    viewHierarchy: ViewHierarchy,
    _screenSize?: ObserveResult["screenSize"]
  ): ViewHierarchyResult | null {
    const filtered = viewHierarchy.filterViewHierarchy(rawHierarchy);
    attachRawViewHierarchy(filtered, rawHierarchy);
    return filtered;
  }

  async isAccessibilityServiceEnabled(
    device: BootedDevice,
    adb: AdbExecutor,
    _iosCtrlProxy: IOSCtrlProxy
  ): Promise<boolean> {
    const method = await this.accessibilityDetector.detectMethod(device.deviceId, adb);
    return method === "talkback";
  }

  shouldRunPreTapStability(options: TapOnElementOptions): boolean {
    return Boolean(options.preTapStability);
  }

  shouldRetryTapIfNoChange(): boolean {
    return true;
  }

  getLongPressDurationMs(): number {
    return AndroidTapStrategy.LONG_PRESS_DURATION_MS;
  }
}
