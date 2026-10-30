import {
  type CurrentFocusResult,
  type TraversalOrderResult,
  type ViewHierarchyResult,
} from "../../models";
import type { AccessibilityNodeSelector, A11yActionResult } from "../observe/android/types";
import type { FocusDriverClient, FocusNavigationDriver } from "./FocusNavigationExecutor";

export class DefaultFocusNavigationDriver implements FocusNavigationDriver {
  private accessibilityService: FocusDriverClient;
  constructor(accessibilityService: FocusDriverClient) {
    this.accessibilityService = accessibilityService;
  }

  async getAccessibilityHierarchy(): Promise<ViewHierarchyResult | null> {
    return this.accessibilityService.getAccessibilityHierarchy(undefined, {
      skipWaitForFresh: false,
      disableAllFiltering: true,
    });
  }

  async requestTraversalOrder(): Promise<TraversalOrderResult> {
    return this.accessibilityService.requestTraversalOrder();
  }

  async requestCurrentFocus(): Promise<CurrentFocusResult> {
    return this.accessibilityService.requestCurrentFocus();
  }

  async requestAction(
    action: string,
    resourceId?: string,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    return this.accessibilityService.requestAction(action, resourceId, undefined, undefined, {
      signal,
    });
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
