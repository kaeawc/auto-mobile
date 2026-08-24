/**
 * CtrlProxyFocus - Delegate for TalkBack focus and traversal operations.
 *
 * This delegate handles accessibility focus (TalkBack cursor) operations including
 * getting current focus, traversal order, and setting/clearing focus.
 */

import WebSocket from "ws";
import { logger } from "../../../utils/logger";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import type { CurrentFocusResult, TraversalOrderResult, Element } from "../../../models";
import type { DelegateContext, AccessibilityNode, A11yActionResult } from "./types";
import { ctrlProxyRequests, serializeCtrlProxyRequest } from "./ctrlProxyProtocol";
import { DefaultElementParser } from "../../utility/ElementParser";

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
   * @throws Error if resourceId is empty, the node is not found, or the action fails
   */
  async clearAccessibilityFocus(
    resourceId: string,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<void> {
    if (!resourceId) {
      throw new Error("clearAccessibilityFocus requires a resource-id");
    }
    const result = await this.sendAction("clear_focus", resourceId, timeoutMs, perf);
    if (!result.success) {
      throw new Error(result.error ?? `Failed to clear accessibility focus on ${resourceId}`);
    }
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
   * @throws Error if resourceId is empty, the node is not found, or the action fails
   */
  async setAccessibilityFocus(
    resourceId: string,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<void> {
    if (!resourceId) {
      throw new Error("setAccessibilityFocus requires a resource-id");
    }
    const result = await this.sendAction("focus", resourceId, timeoutMs, perf);
    if (!result.success) {
      throw new Error(result.error ?? `Failed to set accessibility focus on ${resourceId}`);
    }
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

    try {
      const connected = await perf.track("ensureConnection", () =>
        this.context.ensureConnected(perf),
      );
      if (!connected) {
        logger.warn(`[CTRL_PROXY] Failed to establish WebSocket connection for action '${action}'`);
        return {
          success: false,
          action,
          totalTimeMs: this.context.timer.now() - startTime,
          error: "Failed to connect to accessibility service",
        };
      }

      const requestId = this.context.requestManager.generateId("action");

      const actionPromise = this.context.requestManager.register<A11yActionResult>(
        requestId,
        "action",
        timeoutMs,
        (_id, _type, timeout) => ({
          success: false,
          action,
          totalTimeMs: this.context.timer.now() - startTime,
          error: `Action timeout after ${timeout}ms`,
        }),
      );

      await perf.track("sendRequest", async () => {
        const ws = this.context.getWebSocket();
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket not connected");
        }
        const message = serializeCtrlProxyRequest(
          ctrlProxyRequests.requestAction({ requestId, action, resourceId }),
        );
        ws.send(message);
        logger.debug(
          `[CTRL_PROXY] Sent action request (requestId: ${requestId}, action: ${action}, resourceId: ${resourceId})`,
        );
      });

      const result = await perf.track("waitForAction", () => actionPromise);

      const duration = this.context.timer.now() - startTime;
      if (result.success) {
        logger.debug(`[CTRL_PROXY] Action '${action}' completed in ${duration}ms`);
      } else {
        logger.warn(`[CTRL_PROXY] Action '${action}' failed after ${duration}ms: ${result.error}`);
      }

      return result;
    } catch (error) {
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

    try {
      // Ensure WebSocket connection is established
      const connected = await perf.track("ensureConnection", () =>
        this.context.ensureConnected(perf),
      );
      if (!connected) {
        logger.warn("[CTRL_PROXY] Failed to establish WebSocket connection for current focus");
        return {
          focusedElement: null,
          totalTimeMs: this.context.timer.now() - startTime,
          error: "Failed to connect to accessibility service",
        };
      }

      // Send current focus request
      const requestId = this.context.requestManager.generateId("currentFocus");

      // Register request with automatic timeout handling
      const focusPromise = this.context.requestManager.register<CurrentFocusResult>(
        requestId,
        "currentFocus",
        timeoutMs,
        (_id, _type, timeout) => ({
          focusedElement: null,
          totalTimeMs: this.context.timer.now() - startTime,
          error: `Current focus timeout after ${timeout}ms`,
        }),
      );

      // Send the request
      await perf.track("sendRequest", async () => {
        const ws = this.context.getWebSocket();
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket not connected");
        }
        const message = serializeCtrlProxyRequest(ctrlProxyRequests.getCurrentFocus({ requestId }));
        ws.send(message);
        logger.debug(`[CTRL_PROXY] Sent current focus request (requestId: ${requestId})`);
      });

      // Wait for response
      const result = await perf.track("waitForCurrentFocus", () => focusPromise);

      const duration = this.context.timer.now() - startTime;
      if (result.error) {
        logger.warn(`[CTRL_PROXY] Current focus failed after ${duration}ms: ${result.error}`);
      } else {
        logger.info(`[CTRL_PROXY] Current focus received in ${duration}ms`);
      }

      return result;
    } catch (error) {
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

    try {
      // Ensure WebSocket connection is established
      const connected = await perf.track("ensureConnection", () =>
        this.context.ensureConnected(perf),
      );
      if (!connected) {
        logger.warn("[CTRL_PROXY] Failed to establish WebSocket connection for traversal order");
        return {
          elements: [],
          focusedIndex: null,
          totalCount: 0,
          totalTimeMs: this.context.timer.now() - startTime,
          error: "Failed to connect to accessibility service",
        };
      }

      // Send traversal order request
      const requestId = this.context.requestManager.generateId("traversalOrder");

      // Register request with automatic timeout handling
      const traversalPromise = this.context.requestManager.register<TraversalOrderResult>(
        requestId,
        "traversalOrder",
        timeoutMs,
        (_id, _type, timeout) => ({
          elements: [],
          focusedIndex: null,
          totalCount: 0,
          totalTimeMs: this.context.timer.now() - startTime,
          error: `Traversal order timeout after ${timeout}ms`,
        }),
      );

      // Send the request
      await perf.track("sendRequest", async () => {
        const ws = this.context.getWebSocket();
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          throw new Error("WebSocket not connected");
        }
        const message = serializeCtrlProxyRequest(
          ctrlProxyRequests.getTraversalOrder({ requestId }),
        );
        ws.send(message);
        logger.debug(`[CTRL_PROXY] Sent traversal order request (requestId: ${requestId})`);
      });

      // Wait for response
      const result = await perf.track("waitForTraversalOrder", () => traversalPromise);

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
    if (node.clickable && node.clickable !== "false") {
      converted.clickable = node.clickable;
    }
    if (node.enabled && node.enabled !== "false") {
      converted.enabled = node.enabled;
    }
    if (node.focusable && node.focusable !== "false") {
      converted.focusable = node.focusable;
    }
    if (node.focused && node.focused !== "false") {
      converted.focused = node.focused;
    }
    if (node.scrollable && node.scrollable !== "false") {
      converted.scrollable = node.scrollable;
    }
    if (node.password && node.password !== "false") {
      converted.password = node.password;
    }
    if (node.checkable && node.checkable !== "false") {
      converted.checkable = node.checkable;
    }
    if (node.checked && node.checked !== "false") {
      converted.checked = node.checked;
    }
    if (node.selected && node.selected !== "false") {
      converted.selected = node.selected;
    }
    if (node["long-clickable"] && node["long-clickable"] !== "false") {
      converted["long-clickable"] = node["long-clickable"];
    }

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

    // Convert child nodes recursively
    if (node.node) {
      converted.node = this.convertAccessibilityNode(node.node);
    }

    return converted;
  }
}
