import type { BootedDevice } from "../../models";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type {
  AccessibilityNodeSelector,
  A11yActionResult,
  A11yTapCoordinatesResult,
} from "../observe/android/types";
import { AndroidCtrlProxyClient } from "../observe/android";
import type { FocusNavigationDriver } from "./FocusNavigationExecutor";

/**
 * Extended driver interface for TalkBack navigation that adds tap and action capabilities.
 * This interface is used by TalkBackTapStrategy to perform element activation after navigation.
 */
export interface TalkBackNavigationDriver extends FocusNavigationDriver {
  /**
   * Request a tap at specific coordinates via accessibility service.
   * @param x - X coordinate
   * @param y - Y coordinate
   * @param durationMs - Duration of the tap in milliseconds
   */
  requestTapCoordinates(
    x: number,
    y: number,
    durationMs: number,
  ): Promise<A11yTapCoordinatesResult>;

  /**
   * Request an accessibility action on an element.
   * @param action - The action to perform (e.g., "click", "long_click")
   * @param resourceId - Optional resource ID of the target element
   */
  requestAction(action: string, resourceId?: string): Promise<A11yActionResult>;

  /** Request an accessibility action using stable fields observed from a node. */
  requestNodeAction(action: string, selector: AccessibilityNodeSelector): Promise<A11yActionResult>;

  /** Whether the connected runner can resolve stable node selectors. */
  supportsNodeActionSelectors(): Promise<boolean>;
}

/**
 * Default implementation of TalkBackNavigationDriver using AndroidCtrlProxyClient.
 */
class DefaultTalkBackNavigationDriver implements TalkBackNavigationDriver {
  private accessibilityService: AndroidCtrlProxyClient;
  constructor(accessibilityService: AndroidCtrlProxyClient) {
    this.accessibilityService = accessibilityService;
  }

  async requestTraversalOrder() {
    return this.accessibilityService.requestTraversalOrder();
  }

  async requestCurrentFocus() {
    return this.accessibilityService.requestCurrentFocus();
  }

  async requestSwipe(x1: number, y1: number, x2: number, y2: number, durationMs: number) {
    return this.accessibilityService.requestSwipe(x1, y1, x2, y2, durationMs);
  }

  async getScreenSize() {
    const hierarchy = await this.accessibilityService.getAccessibilityHierarchy(
      undefined,
      undefined,
      true,
    );
    if (!hierarchy?.screenWidth || !hierarchy.screenHeight) {
      throw new Error("CtrlProxy did not provide screen dimensions for TalkBack navigation");
    }
    return { width: hierarchy.screenWidth, height: hierarchy.screenHeight };
  }

  async requestTapCoordinates(
    x: number,
    y: number,
    durationMs: number,
  ): Promise<A11yTapCoordinatesResult> {
    return this.accessibilityService.requestTapCoordinates(x, y, durationMs);
  }

  async requestAction(action: string, resourceId?: string): Promise<A11yActionResult> {
    return this.accessibilityService.requestAction(action, resourceId);
  }

  async requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
  ): Promise<A11yActionResult> {
    return this.accessibilityService.requestNodeAction(action, selector);
  }

  async supportsNodeActionSelectors(): Promise<boolean> {
    return this.accessibilityService.supportsNodeActionSelectors();
  }
}

/**
 * Factory interface for creating TalkBackNavigationDriver instances.
 */
export interface TalkBackNavigationDriverFactory {
  createDriver(device: BootedDevice): TalkBackNavigationDriver;
}

/**
 * Default factory implementation for TalkBackNavigationDriver.
 */
export class DefaultTalkBackNavigationDriverFactory implements TalkBackNavigationDriverFactory {
  constructor(private readonly adbFactory: AdbClientFactory) {}

  createDriver(device: BootedDevice): TalkBackNavigationDriver {
    return new DefaultTalkBackNavigationDriver(
      AndroidCtrlProxyClient.getInstance(device, this.adbFactory),
    );
  }
}
