import type { FocusNavigationDriver } from "../../src/features/talkback/FocusNavigationExecutor";
import type {
  AccessibilityNodeSelector,
  A11yActionResult,
} from "../../src/features/observe/android/types";
import type {
  CurrentFocusResult,
  TraversalOrderResult,
  ViewHierarchyResult,
} from "../../src/models";
import type { Element } from "../../src/models/Element";

export interface FocusRequest {
  action: string;
  resourceId?: string;
  selector?: AccessibilityNodeSelector;
}

/**
 * Fake focus-navigation driver. The cursor only moves through accessibility actions, as on a
 * device: `focus` on a node whose stable identity matches moves focus to it. Nothing here models
 * a swipe, because a gesture an accessibility service dispatches never moves TalkBack's cursor.
 */
export class FakeFocusNavigationDriver implements FocusNavigationDriver {
  elements: Element[] = [];
  focusedIndex: number | null = null;
  /** Result every `focus` request returns. */
  focusResult: A11yActionResult = { success: true, action: "focus", totalTimeMs: 1 };
  /** Every `focus` request, in order. */
  focusHistory: FocusRequest[] = [];
  /** The signal each `focus` request was given, in order. */
  focusSignals: Array<AbortSignal | undefined> = [];
  /** When true a successful `focus` request moves the cursor onto the addressed node. */
  autoFocusOnAction = true;
  /** Called after every `focus` request, before it returns. */
  onFocusAction: ((request: FocusRequest) => void) | null = null;
  nodeActionSelectorsSupported = true;
  /** Expose the elements as the full accessibility tree (needed by resource-id uniqueness checks). */
  exposeHierarchy = false;
  private traversalOverrides: TraversalOrderResult[] = [];
  private currentFocusOverrides: CurrentFocusResult[] = [];

  setElements(elements: Element[], focusedIndex: number | null): void {
    this.elements = elements;
    this.focusedIndex = focusedIndex;
  }

  /** Replace what the screen shows, keeping the cursor on the same node when it still exists. */
  replaceElements(elements: Element[], preserveFocus: boolean = true): void {
    const focusedElement = preserveFocus ? this.getFocusedElement() : null;
    this.elements = elements;
    if (focusedElement) {
      const focusedKey = this.getElementKey(focusedElement);
      const index = focusedKey
        ? elements.findIndex((element) => this.getElementKey(element) === focusedKey)
        : -1;
      this.focusedIndex = index === -1 ? null : index;
    }
  }

  queueTraversalResult(result: TraversalOrderResult): void {
    this.traversalOverrides.push(result);
  }

  queueCurrentFocusResult(result: CurrentFocusResult): void {
    this.currentFocusOverrides.push(result);
  }

  getFocusRequestCount(): number {
    return this.focusHistory.length;
  }

  getFocusedElement(): Element | null {
    if (this.focusedIndex === null || this.focusedIndex === undefined) {
      return null;
    }
    return this.elements[this.focusedIndex] ?? null;
  }

  async getAccessibilityHierarchy(): Promise<ViewHierarchyResult | null> {
    if (!this.exposeHierarchy) {
      return null;
    }
    return { hierarchy: { node: this.elements.map((element) => ({ $: element })) } };
  }

  async requestTraversalOrder(): Promise<TraversalOrderResult> {
    if (this.traversalOverrides.length > 0) {
      return this.traversalOverrides.shift()!;
    }
    return {
      elements: this.elements,
      focusedIndex: this.focusedIndex,
      totalCount: this.elements.length,
      totalTimeMs: 1,
    };
  }

  async requestCurrentFocus(): Promise<CurrentFocusResult> {
    if (this.currentFocusOverrides.length > 0) {
      return this.currentFocusOverrides.shift()!;
    }
    return {
      focusedElement: this.getFocusedElement(),
      totalTimeMs: 1,
    };
  }

  async requestAction(
    action: string,
    resourceId?: string,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    return this.handleAction({ action, resourceId }, signal);
  }

  async requestNodeAction(
    action: string,
    selector: AccessibilityNodeSelector,
    signal?: AbortSignal,
  ): Promise<A11yActionResult> {
    return this.handleAction({ action, selector }, signal);
  }

  async supportsNodeActionSelectors(): Promise<boolean> {
    return this.nodeActionSelectorsSupported;
  }

  /** Overridable by drivers that also record other actions; `focus` is handled here. */
  protected handleAction(request: FocusRequest, signal?: AbortSignal): A11yActionResult {
    if (request.action !== "focus") {
      return { success: true, action: request.action, totalTimeMs: 1 };
    }
    this.focusHistory.push(request);
    this.focusSignals.push(signal);
    if (this.focusResult.success && this.autoFocusOnAction) {
      const index = this.elements.findIndex((element) => this.addresses(request, element));
      if (index !== -1) {
        this.focusedIndex = index;
      }
    }
    this.onFocusAction?.(request);
    return this.focusResult;
  }

  private addresses(request: FocusRequest, element: Element): boolean {
    // Like the device's node lookup, every field the request names must match the node.
    const resourceId = request.selector?.resourceId ?? request.resourceId;
    const testTag = request.selector?.testTag;
    if (!resourceId && !testTag) {
      return false;
    }
    const nodeId = element["resource-id"];
    const idMatches =
      !resourceId ||
      Boolean(nodeId && (nodeId === resourceId || nodeId.endsWith(`:id/${resourceId}`)));
    return idMatches && (!testTag || element["test-tag"] === testTag);
  }

  private getElementKey(element: Element): string | null {
    const resourceId = element["resource-id"];
    if (typeof resourceId === "string" && resourceId.length > 0) {
      return `resource:${resourceId}`;
    }
    if (typeof element.text === "string" && element.text.length > 0) {
      return `text:${element.text}`;
    }
    return null;
  }
}
