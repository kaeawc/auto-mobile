import type { ViewHierarchyResult } from "../../models";
import type {
  AccessibilityNodeSelector,
  A11yActionResult,
  A11yTapCoordinatesResult,
} from "../observe/android/types";
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
