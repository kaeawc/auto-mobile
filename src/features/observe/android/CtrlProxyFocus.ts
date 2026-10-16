/**
 * CtrlProxyFocus - Delegate for TalkBack focus and traversal operations.
 *
 * This delegate handles accessibility focus (TalkBack cursor) operations including
 * getting current focus, traversal order, and setting/clearing focus.
 */

import { rethrowRealCtrlProxyWebSocketInTestError } from "../DeviceServiceClient";
import { logger } from "../../../utils/logger";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import type { CurrentFocusResult, TraversalOrderResult, Element } from "../../../models";
import type { DelegateContext, AccessibilityNode, A11yActionResult } from "./types";
import { sendCommand } from "../DeviceServiceUtils";
import { DefaultElementParser } from "../../utility/ElementParser";

/**
 * Outcome of a successful set/clear focus request. `alreadySatisfied` is true when the node was
 * already in the requested state, so the runner sent no action (#10148).
 */
export interface FocusActionOutcome {
  alreadySatisfied: boolean;
}

/**
 * Delegate class for handling TalkBack focus and traversal operations.
 */
export class CtrlProxyFocus {
  private readonly context: DelegateContext;

  constructor(context: DelegateContext) {
    this.context = context;
  }

  /**
   * Clear accessibility focus (TalkBack cursor) on a specific element.
   *
   * Sends the "clear_focus" action over the request_action protocol; the
   * CtrlProxy AccessibilityService resolves the node by resource-id and performs
   * ACTION_CLEAR_ACCESSIBILITY_FOCUS on it.
   *
   * @param resourceId - Resource ID of the element whose focus should be cleared
   * @param timeoutMs - Maximum time to wait for the action result in milliseconds
   * @param perf - Performance tracker for timing
   * @returns `alreadySatisfied: true` when the node was not focused, so nothing was sent
   * @throws Error if resourceId is empty, the node is not found, or the action fails
   */
  async clearAccessibilityFocus(
    resourceId: string,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<FocusActionOutcome> {
    if (!resourceId) {
      throw new Error("clearAccessibilityFocus requires a resource-id");
    }
    const result = await this.sendAction("clear_focus", resourceId, timeoutMs, perf);
    if (!result.success) {
      throw new Error(result.error ?? `Failed to clear accessibility focus on ${resourceId}`);
    }
    return { alreadySatisfied: result.alreadySatisfied === true };
  }

  /**
   * Set accessibility focus (TalkBack cursor) on a specific element.
   *
   * Sends the "focus" action over the request_action protocol; the CtrlProxy
   * AccessibilityService resolves the node by resource-id and performs
   * ACTION_ACCESSIBILITY_FOCUS on it.
   *
   * @param resourceId - Resource ID of the element to focus
   * @param timeoutMs - Maximum time to wait for the action result in milliseconds
   * @param perf - Performance tracker for timing
   * @returns `alreadySatisfied: true` when the node already held focus, so nothing was sent
   * @throws Error if resourceId is empty, the node is not found, or the action fails
   */
  async setAccessibilityFocus(
    resourceId: string,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<FocusActionOutcome> {
    if (!resourceId) {
      throw new Error("setAccessibilityFocus requires a resource-id");
    }
    const result = await this.sendAction("focus", resourceId, timeoutMs, perf);
    if (!result.success) {
      throw new Error(result.error ?? `Failed to set accessibility focus on ${resourceId}`);
    }
    return { alreadySatisfied: result.alreadySatisfied === true };
  }

  /**
   * Shared sendCommand wrapper for the focus requests. Auto-connects like the hand-rolled
   * paths did, attaches no ambient abort, and bypasses the generic command gate.
   */
  private sendFocusCommand<T>(request: {
    idPrefix: string;
    messageType: string;
    params: Record<string, unknown>;
    timeoutMs: number;
    perf: PerformanceTracker;
    notConnected: () => T;
    timeout: (timeoutMs: number) => T;
    failure: (error: string) => T;
  }): Promise<T> {
    return sendCommand<T>(
      { ...this.context, isCommandSupported: undefined, wireDeadlineParams: undefined },
      {
        idPrefix: request.idPrefix,
        responseType: request.idPrefix,
        messageType: request.messageType,
        params: request.params,
        timeoutMs: request.timeoutMs,
        perf: request.perf,
        cancelScreenshotBackoff: false,
        notConnectedError: request.notConnected,
        timeoutError: request.timeout,
        unsupportedCommandError: (_messageType, error) => request.failure(error),
      },
    );
  }

  /**
   * Send a node action ("focus" / "clear_focus") to the accessibility service over
   * the request_action WebSocket protocol and await the action result.
   *
   * Mirrors the request/response plumbing used by requestCurrentFocus so the focus
   * delegate stays self-contained (no dependency on the host client's requestAction).
   */
  private async sendAction(
    action: string,
    resourceId: string,
    timeoutMs: number,
    perf: PerformanceTracker,
  ): Promise<A11yActionResult> {
    const startTime = this.context.timer.now();
    const failureResult = (error: string): A11yActionResult => ({
      success: false,
      action,
      totalTimeMs: this.context.timer.now() - startTime,
      error,
    });

    try {
      const result = await this.sendFocusCommand<A11yActionResult>({
        idPrefix: "action",
        messageType: "request_action",
        // resourceId is serialized as-is; an undefined selector is omitted from the wire.
        params: { action, resourceId },
        timeoutMs,
        perf,
        notConnected: () => {
          logger.warn(
            `[CTRL_PROXY] Failed to establish WebSocket connection for action '${action}'`,
          );
          return failureResult("Failed to connect to accessibility service");
        },
        timeout: (timeout) => failureResult(`Action timeout after ${timeout}ms`),
        failure: failureResult,
      });

      const duration = this.context.timer.now() - startTime;
      if (result.success) {
        logger.debug(`[CTRL_PROXY] Action '${action}' completed in ${duration}ms`);
      } else {
        logger.warn(`[CTRL_PROXY] Action '${action}' failed after ${duration}ms: ${result.error}`);
      }

      return result;
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Action '${action}' request failed after ${duration}ms: ${error}`);
      return {
        success: false,
        action,
        totalTimeMs: duration,
        error: `${error}`,
      };
    }
  }

  /**
   * Get the current accessibility focus element (TalkBack cursor position)
   * @param timeoutMs - Maximum time to wait for result in milliseconds
   * @param perf - Performance tracker for timing
   * @returns Promise<CurrentFocusResult> - The current focus result
   */
  async requestCurrentFocus(
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<CurrentFocusResult> {
    const startTime = this.context.timer.now();
    const failureResult = (error: string): CurrentFocusResult => ({
      focusedElement: null,
      totalTimeMs: this.context.timer.now() - startTime,
      error,
    });

    try {
      const result = await this.sendFocusCommand<CurrentFocusResult>({
        idPrefix: "currentFocus",
        messageType: "get_current_focus",
        params: {},
        timeoutMs,
        perf,
        notConnected: () => {
          logger.warn("[CTRL_PROXY] Failed to establish WebSocket connection for current focus");
          return failureResult("Failed to connect to accessibility service");
        },
        timeout: (timeout) => failureResult(`Current focus timeout after ${timeout}ms`),
        failure: failureResult,
      });

      const duration = this.context.timer.now() - startTime;
      if (result.error) {
        logger.warn(`[CTRL_PROXY] Current focus failed after ${duration}ms: ${result.error}`);
      } else {
        logger.info(`[CTRL_PROXY] Current focus received in ${duration}ms`);
      }

      return result;
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Current focus request failed after ${duration}ms: ${error}`);
      return {
        focusedElement: null,
        totalTimeMs: duration,
        error: `${error}`,
      };
    }
  }

  /**
   * Get the traversal order of accessibility-focusable elements
   * @param timeoutMs - Maximum time to wait for result in milliseconds
   * @param perf - Performance tracker for timing
   * @returns Promise<TraversalOrderResult> - The traversal order result
   */
  async requestTraversalOrder(
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<TraversalOrderResult> {
    const startTime = this.context.timer.now();
    const failureResult = (error: string): TraversalOrderResult => ({
      elements: [],
      focusedIndex: null,
      totalCount: 0,
      totalTimeMs: this.context.timer.now() - startTime,
      error,
    });

    try {
      const result = await this.sendFocusCommand<TraversalOrderResult>({
        idPrefix: "traversalOrder",
        messageType: "get_traversal_order",
        params: {},
        timeoutMs,
        perf,
        notConnected: () => {
          logger.warn("[CTRL_PROXY] Failed to establish WebSocket connection for traversal order");
          return failureResult("Failed to connect to accessibility service");
        },
        timeout: (timeout) => failureResult(`Traversal order timeout after ${timeout}ms`),
        failure: failureResult,
      });

      const duration = this.context.timer.now() - startTime;
      if (result.error) {
        logger.warn(`[CTRL_PROXY] Traversal order failed after ${duration}ms: ${result.error}`);
      } else {
        logger.info(
          `[CTRL_PROXY] Traversal order received in ${duration}ms (${result.totalCount} elements)`,
        );
      }

      return result;
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Traversal order request failed after ${duration}ms: ${error}`);
      return {
        elements: [],
        focusedIndex: null,
        totalCount: 0,
        totalTimeMs: duration,
        error: `${error}`,
      };
    }
  }

  /**
   * Convert AccessibilityNode to Element type.
   * This is used by the main client's message handler to process focus results.
   * @param node - Accessibility node from WebSocket message
   * @returns Converted Element or null if conversion fails
   */
  convertAccessibilityNodeToElement(node: AccessibilityNode): Element | null {
    try {
      // First convert to intermediate format
      const converted = this.convertAccessibilityNode(node);

      // Then parse to Element using ElementParser
      const elementParser = new DefaultElementParser();
      return elementParser.parseNodeBounds(converted);
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Failed to convert node to Element: ${error}`);
      return null;
    }
  }

  /**
   * Convert accessibility node to intermediate format for ElementParser.
   */
  private convertAccessibilityNode(node: AccessibilityNode | AccessibilityNode[]): any {
    // Handle array of nodes
    if (Array.isArray(node)) {
      const convertedArray = node.map((child) => this.convertAccessibilityNode(child));
      return convertedArray.length === 1 ? convertedArray[0] : convertedArray;
    }

    const converted: any = {};

    // Copy over all properties
    this.copyNodeIdentity(node, converted);
    this.copyNodeFlags(node, converted);
    this.copyNodeMetadata(node, converted);

    // Convert child nodes recursively
    if (node.node) {
      converted.node = this.convertAccessibilityNode(node.node);
    }

    return converted;
  }

  private copyNodeIdentity(node: AccessibilityNode, converted: Record<string, unknown>): void {
    if (node.text) {
      converted.text = node.text;
    }
    if (node["content-desc"]) {
      converted["content-desc"] = node["content-desc"];
    }
    if (node["resource-id"]) {
      converted["resource-id"] = node["resource-id"];
    }
    if (node["test-tag"]) {
      converted["test-tag"] = node["test-tag"];
    }
    if (node["view-id"]) {
      converted["view-id"] = node["view-id"];
    }
    if (node.className) {
      converted.class = node.className;
      converted.className = node.className;
    }
    if (node.packageName) {
      converted.packageName = node.packageName;
    }
  }

  private copyNodeFlags(node: AccessibilityNode, converted: Record<string, unknown>): void {
    // Enabled defaults to true, unlike the default-false flags below.
    if (node.enabled !== undefined && node.enabled !== null) {
      converted.enabled = node.enabled;
    }
    for (const key of [
      "clickable",
      "focusable",
      "focused",
      "scrollable",
      "password",
      "checkable",
      "checked",
      "selected",
      "long-clickable",
    ] as const) {
      if (node[key] && node[key] !== "false") {
        converted[key] = node[key];
      }
    }
  }

  private copyNodeMetadata(node: AccessibilityNode, converted: Record<string, unknown>): void {
    if (node.occlusionState) {
      converted.occlusionState = node.occlusionState;
    }
    if (node.occludedBy) {
      converted.occludedBy = node.occludedBy;
    }
    if (node.occludedByViewId) {
      converted.occludedByViewId = node.occludedByViewId;
    }
    if (node.extras) {
      converted.extras = node.extras;
    }
    if (node.recomposition) {
      converted.recomposition = node.recomposition;
    }

    if (node.bounds) {
      converted.bounds = node.bounds;
    }
  }
}
