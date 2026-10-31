import type { ViewHierarchyResult } from "../../models";
import type {
  AccessibilityNodeSelector,
  A11yActionResult,
  A11yTapCoordinatesResult,
} from "../observe/android/types";
import type { TapCoordinatesRequest } from "../observe/shared/SharedGestureDelegate";
import type { TalkBackDriverClient, TalkBackNavigationDriver } from "./TalkBackNavigationDriver";

/**
 * Default implementation of TalkBackNavigationDriver using AndroidCtrlProxyClient.
 */
export class DefaultTalkBackNavigationDriver implements TalkBackNavigationDriver {
  private accessibilityService: TalkBackDriverClient;
  constructor(accessibilityService: TalkBackDriverClient) {
    this.accessibilityService = accessibilityService;
  }

  async getAccessibilityHierarchy(): Promise<ViewHierarchyResult | null> {
    return this.accessibilityService.getAccessibilityHierarchy(undefined, {
      skipWaitForFresh: false,
      disableAllFiltering: true,
    });
  }

  async requestTraversalOrder() {
    return this.accessibilityService.requestTraversalOrder();
  }

  async requestCurrentFocus() {
    return this.accessibilityService.requestCurrentFocus();
  }

  async requestTapCoordinates(request: TapCoordinatesRequest): Promise<A11yTapCoordinatesResult> {
    const { x, y, duration: durationMs = 10, onDispatch } = request;

    return this.accessibilityService.requestTapCoordinates({
      x,
      y,
      duration: durationMs,
      onDispatch,
    });
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
    return this.accessibilityService.requestAction(action, resourceId, undefined, { signal });
  }

  async requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    return this.accessibilityService.requestNodeAction(action, selector, { signal });
  }

  async supportsNodeActionSelectors(): Promise<boolean> {
    return this.accessibilityService.supportsNodeActionSelectors();
  }
}
