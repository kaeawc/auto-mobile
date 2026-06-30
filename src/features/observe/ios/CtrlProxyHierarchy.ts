/**
 * CtrlProxy iOSHierarchy - Delegate for hierarchy operations.
 *
 * This delegate handles hierarchy retrieval, caching, and conversion
 * via the iOS CtrlProxy iOS WebSocket API.
 */

import type { ViewHierarchyResult } from "../../../models";
import type { ViewHierarchyQueryOptions } from "../../../models/ViewHierarchyQueryOptions";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { logger } from "../../../utils/logger";
import type {
  HierarchyDelegateContext,
  CtrlProxyNode,
  XCTestHierarchy,
  CtrlProxyHierarchyResponse,
  CtrlProxyPerfTiming,
  CachedHierarchy,
} from "./types";

/** Converted node format — `$` carries standard attributes, `extras` carries SDK walker data. */
interface ConvertedNode {
  $: Record<string, unknown>;
  extras?: Record<string, string>;
  node?: ConvertedNode[];
}

/**
 * Delegate class for handling hierarchy operations.
 */
export class CtrlProxyHierarchy {
  private readonly context: HierarchyDelegateContext;

  // Track the last known foreground app to detect stale cache from a different app
  private lastKnownPackageName: string | null = null;

  constructor(context: HierarchyDelegateContext) {
    this.context = context;
  }

  /**
   * Check if there is a cached hierarchy.
   */
  hasCachedHierarchy(): boolean {
    return this.context.getCachedHierarchy() !== null;
  }

  /**
   * Invalidate the cache (mark as not fresh).
   */
  invalidateCache(): void {
    const cached = this.context.getCachedHierarchy();
    if (cached) {
      cached.fresh = false;
    }
  }

  /**
   * Get the accessibility hierarchy converted to ViewHierarchyResult format.
   */
  async getAccessibilityHierarchy(
    queryOptions?: ViewHierarchyQueryOptions,
    perf?: PerformanceTracker,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
    disableAllFiltering?: boolean
  ): Promise<ViewHierarchyResult | null> {
    const response = await this.getLatestHierarchy(
      !skipWaitForFresh,
      15000, // Increased from 2000ms - XCUITest hierarchy extraction is slow
      perf,
      skipWaitForFresh,
      minTimestamp
    );

    if (!response.hierarchy) {
      return null;
    }

    return this.convertToViewHierarchyResult(response.hierarchy);
  }

  /**
   * Get the latest hierarchy, optionally waiting for fresh data.
   */
  async getLatestHierarchy(
    waitForFresh: boolean = false,
    timeout: number = 15000,
    perf?: PerformanceTracker,
    skipWaitForFresh: boolean = false,
    minTimestamp: number = 0
  ): Promise<CtrlProxyHierarchyResponse> {
    // Check cache first
    const cachedHierarchy = this.context.getCachedHierarchy();
    if (cachedHierarchy) {
      const cacheAge = this.context.timer.now() - cachedHierarchy.receivedAt;
      const isFresh = cacheAge < this.context.cacheFreshTtlMs;
      const meetsMinTimestamp = minTimestamp === 0 || cachedHierarchy.hierarchy.updatedAt >= minTimestamp;

      if (isFresh && meetsMinTimestamp) {
        if (cachedHierarchy.hierarchy.packageName) {
          this.lastKnownPackageName = cachedHierarchy.hierarchy.packageName;
        }
        return {
          hierarchy: cachedHierarchy.hierarchy,
          fresh: true,
          updatedAt: cachedHierarchy.hierarchy.updatedAt,
          perfTiming: cachedHierarchy.perfTiming
        };
      }
    }

    // Need fresh data
    if (!skipWaitForFresh) {
      const result = await this.requestHierarchySync(perf, false, undefined, timeout);
      if (result) {
        if (result.hierarchy.packageName) {
          this.lastKnownPackageName = result.hierarchy.packageName;
        }
        return {
          hierarchy: result.hierarchy,
          fresh: true,
          updatedAt: result.hierarchy.updatedAt,
          perfTiming: result.perfTiming
        };
      }

      const reconnectStatus = this.context.getReconnectStatus?.();
      if (reconnectStatus) {
        return {
          hierarchy: null,
          fresh: false,
          reconnectStatus,
          reconnectMessage: this.buildReconnectMessage(reconnectStatus.retryAfterSeconds)
        };
      }
    }

    // Return cached (stale) data if available
    if (cachedHierarchy) {
      // Update tracking from cache — it may have been refreshed by a WebSocket push
      if (cachedHierarchy.hierarchy.packageName) {
        if (this.lastKnownPackageName && cachedHierarchy.hierarchy.packageName !== this.lastKnownPackageName) {
          logger.warn(`[CTRL_PROXY] Stale cache packageName differs: cached=${cachedHierarchy.hierarchy.packageName}, lastKnown=${this.lastKnownPackageName}`);
        }
        this.lastKnownPackageName = cachedHierarchy.hierarchy.packageName;
      }
      return {
        hierarchy: cachedHierarchy.hierarchy,
        fresh: false,
        updatedAt: cachedHierarchy.hierarchy.updatedAt,
        perfTiming: cachedHierarchy.perfTiming
      };
    }

    const reconnectStatus = this.context.getReconnectStatus?.();
    if (reconnectStatus) {
      return {
        hierarchy: null,
        fresh: false,
        reconnectStatus,
        reconnectMessage: this.buildReconnectMessage(reconnectStatus.retryAfterSeconds)
      };
    }

    return { hierarchy: null, fresh: false };
  }

  private buildReconnectMessage(retryAfterSeconds: number): string {
    return `CtrlProxy reconnecting, retry in ${retryAfterSeconds}s`;
  }

  /**
   * Request a synchronous hierarchy fetch from the device.
   */
  async requestHierarchySync(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs: number = 5000,
    suppressObservationStreamPush: boolean = false
  ): Promise<{ hierarchy: XCTestHierarchy; perfTiming?: CtrlProxyPerfTiming } | null> {
    if (!await this.context.ensureConnected(perf)) {
      return null;
    }

    const requestId = this.context.requestManager.generateId("hierarchy");
    if (suppressObservationStreamPush) {
      this.context.suppressHierarchyObservationStreamPush?.(requestId, timeoutMs);
    }
    const promise = this.context.requestManager.register<{ hierarchy?: XCTestHierarchy; perfTiming?: CtrlProxyPerfTiming }>(
      requestId,
      "hierarchy",
      timeoutMs,
      () => ({ hierarchy: undefined, perfTiming: undefined })
    );

    const message = {
      type: disableAllFiltering ? "request_hierarchy" : "request_hierarchy_if_stale",
      requestId,
      disableAllFiltering: disableAllFiltering ?? false
    };

    const ws = this.context.getWebSocket();
    ws?.send(JSON.stringify(message));

    const result = await promise;

    if (result.hierarchy) {
      // Update cache
      const newCache: CachedHierarchy = {
        hierarchy: result.hierarchy,
        receivedAt: this.context.timer.now(),
        fresh: true,
        perfTiming: result.perfTiming
      };
      this.context.setCachedHierarchy(newCache);

      return {
        hierarchy: result.hierarchy,
        perfTiming: result.perfTiming
      };
    }

    return null;
  }

  /**
   * Convert XCTestHierarchy to ViewHierarchyResult format.
   */
  convertToViewHierarchyResult(hierarchy: XCTestHierarchy): ViewHierarchyResult {
    // Convert to Android-compatible format
    const convertedNode = this.convertNode(hierarchy.hierarchy);

    // Apply filtering to reduce hierarchy size (similar to Android's optimizeHierarchy)
    const filteredNode = this.filterHierarchyNode(convertedNode, true);

    return {
      hierarchy: {
        node: filteredNode ?? undefined
      },
      packageName: hierarchy.packageName,
      updatedAt: hierarchy.updatedAt,
      windows: hierarchy.windows,
      // iOS screen scale factor (e.g., 2.0 for @2x, 3.0 for @3x retina)
      screenScale: hierarchy.screenScale,
      // Screen dimensions in iOS points (logical pixels)
      screenWidth: hierarchy.screenWidth,
      screenHeight: hierarchy.screenHeight,
    };
  }

  // ===========================================================================
  // Private helper methods
  // ===========================================================================

  private convertNode(node: CtrlProxyNode): ConvertedNode {
    const attrs: Record<string, unknown> = {};

    if (node.text) {attrs["text"] = node.text;}
    if (node.value) {attrs["value"] = node.value;}
    const contentDesc = this.readNodeField<string>(node, "contentDesc", "content-desc");
    const resourceId = this.readNodeField<string>(node, "resourceId", "resource-id");
    const testTag = this.readNodeField<string>(node, "testTag", "test-tag");
    const accessibilityFocused = this.readNodeField<string>(node, "accessibilityFocused", "accessibility-focused");
    const longClickable = this.readNodeField<string>(node, "longClickable", "long-clickable");
    const stateDescription = this.readNodeField<string>(node, "stateDescription", "state-description");
    const errorMessage = this.readNodeField<string>(node, "errorMessage", "error-message");
    const hintText = this.readNodeField<string>(node, "hintText", "hint-text");
    const viewId = this.readNodeField<string>(node, "viewId", "view-id");

    if (contentDesc) {attrs["content-desc"] = contentDesc;}
    if (resourceId) {attrs["resource-id"] = resourceId;}
    if (node.className) {attrs["class"] = node.className;}
    if (testTag) {attrs["test-tag"] = testTag;}
    if (node.bounds) {
      attrs["bounds"] = node.bounds;
    }
    if (node.clickable) {attrs["clickable"] = node.clickable;}
    if (node.enabled) {attrs["enabled"] = node.enabled;}
    if (node.focusable) {attrs["focusable"] = node.focusable;}
    if (node.focused) {attrs["focused"] = node.focused;}
    if (accessibilityFocused) {attrs["accessibility-focused"] = accessibilityFocused;}
    if (node.scrollable) {attrs["scrollable"] = node.scrollable;}
    if (node.password) {attrs["password"] = node.password;}
    if (node.checkable) {attrs["checkable"] = node.checkable;}
    if (node.checked) {attrs["checked"] = node.checked;}
    if (node.selected) {attrs["selected"] = node.selected;}
    if (longClickable) {attrs["long-clickable"] = longClickable;}
    if (stateDescription) {attrs["state-description"] = stateDescription;}
    if (errorMessage) {attrs["error-message"] = errorMessage;}
    if (hintText) {attrs["hint-text"] = hintText;}
    if (viewId) {attrs["view-id"] = viewId;}

    const result: ConvertedNode = { $: attrs };

    if (node.extras && Object.keys(node.extras).length > 0) {
      result.extras = node.extras;
    }

    if (node.node) {
      const children = Array.isArray(node.node) ? node.node : [node.node];
      result.node = children.map(child => this.convertNode(child));
    }

    return result;
  }

  private readNodeField<T>(node: CtrlProxyNode, camelKey: keyof CtrlProxyNode, dashedKey?: string): T | undefined {
    const record = node as Record<string, unknown>;
    if (record[camelKey as string] !== undefined) {
      return record[camelKey as string] as T;
    }
    if (dashedKey && record[dashedKey] !== undefined) {
      return record[dashedKey] as T;
    }
    return undefined;
  }

  /**
   * Check if a node has meaningful content (text, identifier, test-tag)
   */
  private hasContentProperties(attrs: Record<string, string>): boolean {
    return Boolean(
      (attrs["text"] && attrs["text"] !== "") ||
      (attrs["value"] && attrs["value"] !== "") ||
      (attrs["resource-id"] && attrs["resource-id"] !== "") ||
      (attrs["content-desc"] && attrs["content-desc"] !== "") ||
      (attrs["test-tag"] && attrs["test-tag"] !== "") ||
      (attrs["view-id"] && attrs["view-id"] !== "")
    );
  }

  /**
   * Check if a node has meaningful interaction properties
   * Note: iOS marks many containers as clickable, so we're more selective here
   */
  private hasInteractionProperties(attrs: Record<string, string>): boolean {
    return Boolean(
      attrs["scrollable"] === "true" ||
      attrs["focused"] === "true" ||
      attrs["selected"] === "true" ||
      attrs["checked"] === "true"
    );
  }

  /**
   * Check if a node is a structural wrapper (UIView with no meaningful properties)
   */
  private isStructuralWrapper(attrs: Record<string, string>, hasChildren: boolean): boolean {
    const className = attrs["class"] || "";
    const isContainerClass = className === "UIView" || className === "UIImageView";

    // Not a wrapper if it has content or is focused/selected/scrollable
    if (this.hasContentProperties(attrs) || this.hasInteractionProperties(attrs)) {
      return false;
    }

    // Container classes without content are wrappers if they have children
    // UIImageView without text is decorative and can be collapsed
    return isContainerClass && hasChildren;
  }

  /**
   * Clean node attributes by removing false booleans and empty values
   */
  private cleanAttributes(attrs: Record<string, string>): Record<string, string> {
    const cleaned: Record<string, string> = {};
    const booleanFields = ["clickable", "enabled", "focusable", "focused", "scrollable",
      "password", "checkable", "checked", "selected", "long-clickable"];

    for (const [key, value] of Object.entries(attrs)) {
      // Skip empty values
      if (value === "" || value === null || value === undefined) {
        continue;
      }

      // Skip false boolean values
      if (booleanFields.includes(key) && value === "false") {
        continue;
      }

      // Skip enabled=true (it's the default)
      if (key === "enabled" && value === "true") {
        continue;
      }

      cleaned[key] = value;
    }

    return cleaned;
  }

  /**
   * Filter hierarchy node - removes structural wrappers and nodes without meaningful properties
   * Similar to Android's optimizeHierarchy + filterViewHierarchy
   */
  private filterHierarchyNode(
    node: ConvertedNode,
    isRoot: boolean = false
  ): ConvertedNode | null {
    const attrs = node.$ || {};
    const children = node.node || [];

    // Process children first (recursively)
    const filteredChildren: ConvertedNode[] = [];
    for (const child of children) {
      const filtered = this.filterHierarchyNode(child);
      if (filtered) {
        // If child filtering returned an array (promoted grandchildren), flatten it
        if (Array.isArray(filtered)) {
          filteredChildren.push(...filtered);
        } else {
          filteredChildren.push(filtered);
        }
      }
    }

    // Root node is always kept
    if (isRoot) {
      const cleanedAttrs = this.cleanAttributes(attrs);
      const result: ConvertedNode = { $: cleanedAttrs };
      if (node.extras) { result.extras = node.extras; }
      if (filteredChildren.length > 0) {
        result.node = filteredChildren;
      }
      return result;
    }

    // Check if this node is a structural wrapper
    if (this.isStructuralWrapper(attrs, filteredChildren.length > 0)) {
      // Promote children (collapse this wrapper)
      if (filteredChildren.length > 0) {
        // Return children to be flattened into parent
        return filteredChildren as unknown as ConvertedNode;
      }
      // No children and no content - filter out completely
      return null;
    }

    // Check if node has any meaningful properties
    const hasContent = this.hasContentProperties(attrs);
    const hasInteraction = this.hasInteractionProperties(attrs);
    const isClickable = attrs["clickable"] === "true";

    // Keep node if:
    // 1. Has content (text, identifier, etc.)
    // 2. Has interaction properties (scrollable, focused, selected)
    // 3. Is clickable and is a leaf node (actual tappable element)
    // 4. Has meaningful filtered children
    const keepNode = hasContent || hasInteraction || (isClickable && filteredChildren.length === 0) || filteredChildren.length > 0;

    if (!keepNode) {
      return null;
    }

    const cleanedAttrs = this.cleanAttributes(attrs);
    const result: ConvertedNode = { $: cleanedAttrs };
    if (node.extras) { result.extras = node.extras; }
    if (filteredChildren.length > 0) {
      result.node = filteredChildren;
    }
    return result;
  }
}
