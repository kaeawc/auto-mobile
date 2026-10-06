import type { BootedDevice, ViewHierarchyResult } from "../../models";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type {
  AccessibilityNodeSelector,
  A11yActionResult,
  A11yTapCoordinatesResult,
} from "../observe/android/types";
import { AndroidCtrlProxyClient } from "../observe/android";
import type { FocusNavigationDriver } from "./FocusNavigationExecutor";

/**
 * Extended driver interface for TalkBack navigation that adds coordinate tap capabilities to the
 * focus-navigation reads and accessibility actions. This interface is used by TalkBackTapStrategy
 * to perform element activation after navigation.
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
    onDispatch?: () => void,
  ): Promise<A11yTapCoordinatesResult>;

  /** Dispatch both activation taps in one device request. */
  requestDoubleTapCoordinates(
    x: number,
    y: number,
    onDispatch?: () => void,
  ): Promise<A11yTapCoordinatesResult>;
}

/**
 * Default implementation of TalkBackNavigationDriver using AndroidCtrlProxyClient.
 */
class DefaultTalkBackNavigationDriver implements TalkBackNavigationDriver {
  private accessibilityService: AndroidCtrlProxyClient;
  constructor(accessibilityService: AndroidCtrlProxyClient) {
    this.accessibilityService = accessibilityService;
  }

  async getAccessibilityHierarchy(): Promise<ViewHierarchyResult | null> {
    return this.accessibilityService.getAccessibilityHierarchy(
      undefined,
      undefined,
      false,
      undefined,
      true,
    );
  }

  async requestTraversalOrder() {
    return this.accessibilityService.requestTraversalOrder();
  }

  async requestCurrentFocus() {
    return this.accessibilityService.requestCurrentFocus();
  }

  async requestTapCoordinates(
    x: number,
    y: number,
    durationMs: number,
    onDispatch?: () => void,
  ): Promise<A11yTapCoordinatesResult> {
    return this.accessibilityService.requestTapCoordinates(
      x,
      y,
      durationMs,
      undefined,
      undefined,
      undefined,
      onDispatch,
    );
  }

  async requestDoubleTapCoordinates(
    x: number,
    y: number,
    onDispatch?: () => void,
  ): Promise<A11yTapCoordinatesResult> {
    return this.accessibilityService.requestDoubleTapCoordinates(x, y, onDispatch);
  }

  async requestAction(
    action: string,
    resourceId?: string,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    return this.accessibilityService.requestAction(
      action,
      resourceId,
      undefined,
      undefined,
      undefined,
      signal,
    );
  }

  async requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    return this.accessibilityService.requestNodeAction(
      action,
      selector,
      undefined,
      undefined,
      signal,
    );
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
