import { AdbClientFactory, defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { logger, LogLevel } from "../../utils/logger";
import { BootedDevice } from "../../models";
import { Element } from "../../models";
import { ScreenIdentity } from "../../models";
import { ViewHierarchyResult } from "../../models";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import { DefaultElementParser } from "../utility/ElementParser";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import { ViewHierarchyQueryOptions } from "../../models";
import { AndroidCtrlProxyClient } from "./android";
import { IOSCtrlProxyClient } from "./ios";
import { cleanupIosXCTestHierarchy } from "./ios/cleanupIosHierarchy";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { serverConfig } from "../../utils/ServerConfig";
import { attachRawViewHierarchy } from "../../utils/viewHierarchySearch";
import type { ViewHierarchy as ViewHierarchyInterface } from "./interfaces/ViewHierarchy";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { parseBounds } from "../../utils/bounds";

/**
 * Interface for element bounds
 */
interface ElementBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export class ViewHierarchy implements ViewHierarchyInterface {
  private device: BootedDevice;
  private parser: ElementParser;
  private geometry: ElementGeometry;
  private accessibilityServiceClient: AndroidCtrlProxyClient;
  private adbFactory: AdbClientFactory;
  private timer: Timer;

  /**
   * Create a ViewHierarchy instance
   * @param device - Device to get view hierarchy from
   * @param adbFactory - Factory for creating AdbClient instances
   * @param accessibilityServiceClient - Optional AndroidCtrlProxyClient instance for testing
   */
  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    accessibilityServiceClient: AndroidCtrlProxyClient | null = null,
    timer: Timer = defaultTimer,
  ) {
    this.device = device;
    this.parser = new DefaultElementParser();
    this.geometry = new DefaultElementGeometry();

    this.accessibilityServiceClient = accessibilityServiceClient || AndroidCtrlProxyClient.getInstance(device, adbFactory);
    this.adbFactory = adbFactory;
    this.timer = timer;
  }

  async configureRecompositionTracking(
    enabled: boolean,
    perf: PerformanceTracker = new NoOpPerformanceTracker()
  ): Promise<void> {
    if (this.device.platform !== "android") {
      return;
    }

    await this.accessibilityServiceClient.setRecompositionTrackingEnabled(enabled, perf);
  }

  async getScreenIdentity(applicationId?: string): Promise<ScreenIdentity | undefined> {
    if (this.device.platform !== "ios") {
      return undefined;
    }
    return IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)
      ?.refreshSdkScreenIdentity(applicationId);
  }

  /**
   * Retrieve the view hierarchy of the current screen
   * @param queryOptions - Optional query options for targeted element retrieval
   * @param perf - Performance tracker for timing data
   * @param skipWaitForFresh - If true, skip WebSocket wait and go straight to sync method
   * @param minTimestamp - If provided, cached data must have updatedAt >= this value
   * @returns Promise with parsed XML view hierarchy
   */
  async getViewHierarchy(
    queryOptions?: ViewHierarchyQueryOptions,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    skipWaitForFresh: boolean = false,
    minTimestamp: number = 0,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<ViewHierarchyResult> {
    switch (this.device.platform) {
      case "ios":
        return this.getiOSViewHierarchy(perf, skipWaitForFresh, minTimestamp, timeoutMs);
      case "android":
        return this.getAndroidViewHierarchy(queryOptions, perf, skipWaitForFresh, minTimestamp, signal, timeoutMs);
      default:
        throw new Error("Unsupported platform");
    }
  }

  /**
   * Retrieve the view hierarchy of the current screen
   * @param perf - Performance tracker for timing data
   * @param skipWaitForFresh - If true, skip waiting for fresh data and use cache if available
   * @param minTimestamp - If provided, cached data must have updatedAt >= this value
   * @returns Promise with parsed XML view hierarchy
   */
  async getiOSViewHierarchy(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    skipWaitForFresh: boolean = false,
    minTimestamp: number = 0,
    timeoutMs?: number
  ): Promise<ViewHierarchyResult> {
    const startTime = this.timer.now();
    logger.info(`[VIEW_HIERARCHY] Starting getViewHierarchy for iOS (skipWaitForFresh=${skipWaitForFresh}, minTimestamp=${minTimestamp})`);

    perf.serial("ios_viewHierarchy");

    const xcTestClient = IOSCtrlProxyClient.getInstance(this.device);
    const viewHierarchy = await perf.track("ctrlProxyGetHierarchy", async () => {
      // Use getLatestHierarchy which properly handles skipWaitForFresh and minTimestamp
      const result = await xcTestClient.getLatestHierarchy(
        !skipWaitForFresh,        // waitForFresh = opposite of skipWaitForFresh
        timeoutMs ?? 15000,       // timeout: caller budget when supplied
        perf,
        skipWaitForFresh,
        minTimestamp
      );

      if (!result || !result.hierarchy) {
        if (result?.reconnectStatus) {
          return {
            hierarchy: {
              error: result.reconnectMessage ?? `CtrlProxy reconnecting, retry in ${result.reconnectStatus.retryAfterSeconds}s`
            },
            ctrlProxyReconnect: result.reconnectStatus,
            updatedAt: this.timer.now()
          } as ViewHierarchyResult;
        }

        return {
          hierarchy: {
            error: "Failed to retrieve iOS view hierarchy from CtrlProxy iOS"
          },
          updatedAt: this.timer.now()
        };
      }

      // Convert XCTestHierarchy to ViewHierarchyResult format.
      // `result.fresh` says whether the delegate verified this tree against the
      // device on this call or served a host-side cache entry unverified; carry
      // it so ObserveScreen can report freshness instead of assuming it.
      return this.convertXCTestHierarchy(
        result.hierarchy,
        result.updatedAt,
        result.reconnectStatus,
        result.frameContext,
        result.fresh
      );
    });

    perf.end();

    const duration = this.timer.now() - startTime;
    logger.info(`[VIEW_HIERARCHY] Successfully retrieved hierarchy from CtrlProxy iOS in ${duration}ms`);
    return viewHierarchy;
  }

  /**
   * Convert XCTestHierarchy to ViewHierarchyResult format
   */
  private convertXCTestHierarchy(
    hierarchy: any,
    updatedAt?: number,
    ctrlProxyReconnect?: ViewHierarchyResult["ctrlProxyReconnect"],
    frameContext?: string,
    fresh?: boolean
  ): ViewHierarchyResult {
    const cleanedHierarchy = cleanupIosXCTestHierarchy(hierarchy);
    const result = {
      ...cleanedHierarchy,
      updatedAt: updatedAt ?? hierarchy.updatedAt ?? this.timer.now()
    };
    if (ctrlProxyReconnect) {
      result.ctrlProxyReconnect = ctrlProxyReconnect;
    }
    if (frameContext !== undefined) {
      result.frameContext = frameContext;
    }
    if (fresh !== undefined) {
      result.fresh = fresh;
    }
    return result;
  }

  /**
   * Retrieve the view hierarchy of the current screen
   * @param queryOptions - Optional query options for targeted element retrieval
   * @param perf - Performance tracker for timing data
   * @param skipWaitForFresh - If true, skip WebSocket wait and go straight to sync method
   * @param minTimestamp - If provided, cached data must have updatedAt >= this value
   * @returns Promise with parsed view hierarchy
   */
  async getAndroidViewHierarchy(
    queryOptions?: ViewHierarchyQueryOptions,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    skipWaitForFresh: boolean = false,
    minTimestamp: number = 0,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<ViewHierarchyResult> {
    const startTime = this.timer.now();
    logger.debug(`[VIEW_HIERARCHY] Starting Android getViewHierarchy (skipWaitForFresh=${skipWaitForFresh}, minTimestamp=${minTimestamp})`);

    perf.serial("android_viewHierarchy");
    const useRawElementSearch = serverConfig.isRawElementSearchEnabled();

    try {
      const accessibilityHierarchy = await this.accessibilityServiceClient.getAccessibilityHierarchy(
        queryOptions,
        perf,
        skipWaitForFresh,
        minTimestamp,
        useRawElementSearch,
        signal,
        timeoutMs
      );

      if (accessibilityHierarchy) {
        perf.end();
        const duration = this.timer.now() - startTime;
        logger.debug(`[VIEW_HIERARCHY] Successfully retrieved hierarchy from accessibility service in ${duration}ms`);
        return this.prepareHierarchyForResponse(accessibilityHierarchy);
      }

      // Accessibility service returned null
      perf.end();
      logger.warn("[VIEW_HIERARCHY] Accessibility service returned null hierarchy");
      return {
        hierarchy: {
          error: await this.describeHierarchyFailure("Failed to retrieve view hierarchy from accessibility service", signal, timeoutMs)
        },
        updatedAt: this.timer.now()
      };
    } catch (err) {
      perf.end();
      const duration = this.timer.now() - startTime;
      logger.warn(`[VIEW_HIERARCHY] Failed to get hierarchy from accessibility service after ${duration}ms:`, err);
      return {
        hierarchy: {
          error: await this.describeHierarchyFailure("Failed to retrieve view hierarchy", signal, timeoutMs)
        },
        updatedAt: this.timer.now()
      };
    }
  }

  /**
   * Turn a generic Android hierarchy failure into a lock-specific message when
   * the keyguard is actually blocking the app (#4281).
   *
   * A locked device — most commonly a fresh boot before the keyguard is first
   * dismissed — blocks Android from binding non-encryption-aware accessibility
   * services, so the hierarchy read fails with a message that points at the
   * service even though it is healthy. That is indistinguishable from the #4039
   * transport failure, which emits the identical string. Reading the lock state
   * over adb (a `dumpsys` path that works even while the service is unbound) lets
   * us name the real cause. Best-effort: any failure to read the lock state
   * falls back to `fallback`, so this never turns a real transport error into a
   * misleading "device is locked".
   */
  private async describeHierarchyFailure(
    fallback: string,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<string> {
    if (this.device.platform !== "android") {
      return fallback;
    }
    // Only reword the error for an unbudgeted (interactive) observe. A caller that
    // bounds each read -- an aborted signal, or a per-read `timeoutMs` like the
    // keyboard confirmation poll -- is latency-sensitive, and getDeviceLock's
    // `dumpsys window policy` is not itself bounded when no signal aborts it (the
    // keyboard path relies on `timeoutMs`, not a signal). So skip the probe rather
    // than risk blocking past the caller's deadline just to improve wording; the
    // main observe path (HierarchyCollector) passes no timeoutMs and still gets the
    // lock-specific message (#4281 review). The signal is still threaded through so
    // an in-flight dumpsys aborts with the request when one is present.
    if (signal?.aborted || timeoutMs !== undefined) {
      return fallback;
    }
    try {
      const lock = await this.adbFactory.create(this.device).getDeviceLock(signal);
      if (!lock?.locked) {
        return fallback;
      }
      const preamble =
        "Device is locked; a locked device blocks the accessibility service from binding, "
        + "so no view hierarchy is available.";
      if (lock.secure === true) {
        return `${preamble} Unlock the device (PIN/pattern/password) — you may need to ask the user — before observing.`;
      }
      if (lock.secure === false) {
        return `${preamble} Dismiss the keyguard (e.g. swipe up) before observing.`;
      }
      return `${preamble} Unlock or dismiss the keyguard before observing.`;
    } catch (error) {
      // Never let a lock-read failure mask a genuine transport error (#4039); a
      // debug trace is enough since the caller still returns an actionable error.
      logger.debug(`[VIEW_HIERARCHY] Could not read lock state for failure message: ${error}`);
      return fallback;
    }
  }

  /**
   * Check if node meets filter criteria (either string or boolean based)
   * @param props - Node properties
   * @returns True if node meets any filter criteria
   */
  public meetsFilterCriteria(props: any): boolean {
    return this.meetsStringFilterCriteria(props) || this.meetsBooleanFilterCriteria(props);
  }

  /**
   * Filter a single node and its children
   * @param node - Node to filter
   * @param isRootNode - Whether this is the root node
   * @returns Filtered node or null
   */
  public filterSingleNode(node: any, isRootNode: boolean = false): any | null {
    if (!node) {
      return null;
    }

    if (isRootNode) {
      const rootCopy = structuredClone(node);

      if (node.node) {
        // Always overwrite: when every child is filtered out the root must report an
        // empty child list rather than falling back to the raw cloned children.
        const processedChildren = this.processNodeChildren(node, child => this.filterSingleNode(child));
        rootCopy.node = this.normalizeNodeStructure(processedChildren);
      }

      return rootCopy;
    }

    const props = node.$ || node;
    const meetsFilterCriteria = this.meetsFilterCriteria(props);
    const relevantChildren = this.processNodeChildren(node, child => this.filterSingleNode(child));

    if (meetsFilterCriteria) {
      const cleanedNode = this.cleanNodeProperties(node);

      if (relevantChildren.length > 0) {
        cleanedNode.node = this.normalizeNodeStructure(relevantChildren);
      }

      return cleanedNode;
    }

    if (relevantChildren.length > 0) {
      return relevantChildren;
    }

    return null;
  }

  /**
   * Filter the view hierarchy to only include elements that meet specific criteria:
   * - Have resourceId, text, or contentDesc
   * - OR have clickable, scrollable, focused, or selected set to true
   * - Include descendants that meet criteria even if parents don't
   * - Omit boolean fields not set to true and class="android.view.View"
   * @param viewHierarchy - The view hierarchy to filter
   * @returns Filtered view hierarchy
   */
  filterViewHierarchy(viewHierarchy: any): any {
    if (!viewHierarchy || !viewHierarchy.hierarchy) {
      logger.debug("No hierarchy found");
      return viewHierarchy;
    }

    const result = structuredClone(viewHierarchy);
    result.hierarchy = this.filterSingleNode(viewHierarchy.hierarchy, true);
    return result;
  }

  private prepareHierarchyForResponse(rawHierarchy: ViewHierarchyResult): ViewHierarchyResult {
    if (!serverConfig.isRawElementSearchEnabled()) {
      return rawHierarchy;
    }

    if (
      rawHierarchy?.hierarchy &&
      typeof rawHierarchy.hierarchy === "object" &&
      "error" in rawHierarchy.hierarchy &&
      rawHierarchy.hierarchy.error
    ) {
      return rawHierarchy;
    }

    if (this.device.platform !== "android") {
      return rawHierarchy;
    }

    const filtered = this.filterViewHierarchy(rawHierarchy);
    attachRawViewHierarchy(filtered, rawHierarchy);
    return filtered;
  }

  /**
   * Check if bounds are completely offscreen
   * @param bounds - Element bounds
   * @param screenWidth - Screen width
   * @param screenHeight - Screen height
   * @param margin - Extra margin around screen to keep near-visible elements (default 100px)
   * @returns True if element is completely offscreen
   */
  private isCompletelyOffscreen(
    bounds: ElementBounds,
    screenWidth: number,
    screenHeight: number,
    margin: number = 100
  ): boolean {
    // Element is offscreen if it's completely outside the screen + margin
    return (
      bounds.right < -margin ||           // Completely left of screen
      bounds.left > screenWidth + margin ||  // Completely right of screen
      bounds.bottom < -margin ||          // Completely above screen
      bounds.top > screenHeight + margin     // Completely below screen
    );
  }

  /**
   * Recursively filter out offscreen nodes from the hierarchy
   * @param node - Node to filter
   * @param screenWidth - Screen width
   * @param screenHeight - Screen height
   * @param margin - Extra margin to keep near-visible elements
   * @returns Filtered node or null if completely offscreen with no visible children
   */
  private filterOffscreenNode(
    node: any,
    screenWidth: number,
    screenHeight: number,
    margin: number = 100
  ): any | null {
    if (!node) {
      return null;
    }

    const bounds = parseBounds(node.bounds ?? node.$?.bounds);

    // Check if this node is completely offscreen
    const isOffscreen = bounds && this.isCompletelyOffscreen(bounds, screenWidth, screenHeight, margin);

    // Process children
    const children = node.node;
    const filteredChildren: any[] = [];

    if (children) {
      const childArray = Array.isArray(children) ? children : [children];
      for (const child of childArray) {
        const filteredChild = this.filterOffscreenNode(child, screenWidth, screenHeight, margin);
        if (filteredChild !== null) {
          if (Array.isArray(filteredChild)) {
            filteredChildren.push(...filteredChild);
          } else {
            filteredChildren.push(filteredChild);
          }
        }
      }
    }

    // If node is offscreen but has visible children, return just the children
    if (isOffscreen && filteredChildren.length > 0) {
      return filteredChildren.length === 1 ? filteredChildren[0] : filteredChildren;
    }

    // If node is offscreen and has no visible children, filter it out
    if (isOffscreen && filteredChildren.length === 0) {
      return null;
    }

    // Node is visible - return it with filtered children
    const result = { ...node };
    if (filteredChildren.length > 0) {
      result.node = filteredChildren.length === 1 ? filteredChildren[0] : filteredChildren;
    } else if (node.node) {
      delete result.node;
    }

    return result;
  }

  /**
   * Filter out completely offscreen nodes from the view hierarchy
   * This reduces hierarchy size significantly for scrollable content (like YouTube)
   * @param viewHierarchy - The view hierarchy to filter
   * @param screenWidth - Screen width in pixels
   * @param screenHeight - Screen height in pixels
   * @param margin - Extra margin around screen to keep near-visible elements (default 100px)
   * @returns Filtered view hierarchy with offscreen nodes removed
   */
  filterOffscreenNodes(
    viewHierarchy: any,
    screenWidth: number,
    screenHeight: number,
    margin: number = 100
  ): any {
    if (!viewHierarchy || !viewHierarchy.hierarchy || screenWidth <= 0 || screenHeight <= 0) {
      return viewHierarchy;
    }

    const result = { ...viewHierarchy };
    result.hierarchy = this.filterOffscreenNode(viewHierarchy.hierarchy, screenWidth, screenHeight, margin);

    if (logger.getLogLevel() <= LogLevel.DEBUG) {
      const originalSize = JSON.stringify(viewHierarchy.hierarchy).length;
      const filteredSize = JSON.stringify(result.hierarchy).length;
      const reduction = Math.round((1 - filteredSize / originalSize) * 100);

      if (reduction > 10) {
        logger.debug(`Offscreen filtering reduced hierarchy by ${reduction}% (${originalSize} -> ${filteredSize} bytes)`);
      }
    }

    return result;
  }

  /**
   * Check if node meets string-based filter criteria
   * @param props - Node properties
   * @returns True if node has meaningful string properties
   */
  meetsStringFilterCriteria(props: any): boolean {
    return Boolean(
      (props.resourceId && props.resourceId !== "") ||
      (props["resource-id"] && props["resource-id"] !== "") ||
      (props.viewId && props.viewId !== "") ||
      (props["view-id"] && props["view-id"] !== "") ||
      (props.text && props.text !== "") ||
      (props.contentDesc && props.contentDesc !== "") ||
      (props["content-desc"] && props["content-desc"] !== "") ||
      (props["test-tag"] && props["test-tag"] !== "") ||
      (props.role && props.role !== "") ||
      (props["state-description"] && props["state-description"] !== "") ||
      (props["error-message"] && props["error-message"] !== "") ||
      (props["hint-text"] && props["hint-text"] !== "") ||
      (props["tooltip-text"] && props["tooltip-text"] !== "") ||
      (props["pane-title"] && props["pane-title"] !== "") ||
      (props["live-region"] && props["live-region"] !== "") ||
      (props["collection-info"] && props["collection-info"] !== "") ||
      (props["collection-item-info"] && props["collection-item-info"] !== "") ||
      (props["range-info"] && props["range-info"] !== "") ||
      (props["input-type"] && props["input-type"] !== "") ||
      props.recomposition ||
      props.recompositionMetrics
    );
  }

  /**
   * Check if node meets boolean-based filter criteria
   * @param props - Node properties
   * @returns True if node has meaningful boolean properties
   */
  meetsBooleanFilterCriteria(props: any): boolean {
    return Boolean(
      (props.clickable === "true") ||
      (props.focusable === "true") ||
      (props.scrollable === "true") ||
      (props.focused === "true") ||
      (props["accessibility-focused"] === "true") ||
      (props.checkable === "true") ||
      (props.checked === "true") ||
      (props.selected === "true") ||
      (props.selected === true) ||
      (props["long-clickable"] === "true") ||
      (Array.isArray(props.actions) && props.actions.length > 0) ||
      (props.extras && Object.keys(props.extras).length > 0)
    );
  }

  /**
   * Process node children with filter function
   * @param node - Parent node
   * @param filterFn - Filter function to apply to children
   * @returns Array of filtered children
   */
  processNodeChildren(node: any, filterFn: (child: any) => any): any[] {
    const relevantChildren: any[] = [];

    if (node.node) {
      const children = (Array.isArray(node.node) ? node.node : [node.node]).slice(0, 64);
      for (const child of children) {
        const filteredChild = filterFn(child);
        if (filteredChild) {
          if (Array.isArray(filteredChild)) {
            relevantChildren.push(...filteredChild);
          } else {
            relevantChildren.push(filteredChild);
          }
        }
      }
    }

    return relevantChildren;
  }

  /**
   * Normalize node structure for filtered children
   * @param filteredChildren - Array of filtered children
   * @returns Normalized node structure (single item or array)
   */
  normalizeNodeStructure(filteredChildren: any[]): any {
    return filteredChildren.length === 1 ? filteredChildren[0] : filteredChildren;
  }

  /**
   * Find the focused element in the view hierarchy
   * @param viewHierarchy - The view hierarchy to search
   * @returns The focused element or null if none found
   */
  findFocusedElement(viewHierarchy: any): Element | null {
    return this.findElementByProperty(viewHierarchy, "focused");
  }

  /**
   * Find the accessibility-focused element (TalkBack cursor position) in the view hierarchy.
   * First checks the top-level accessibility-focused-element field, then traverses if needed.
   */
  findAccessibilityFocusedElement(viewHierarchy: any): Element | null {
    if (!viewHierarchy) {
      return null;
    }

    // First check if accessibility-focused-element is provided at the top level (from Kotlin)
    if (viewHierarchy["accessibility-focused-element"]) {
      const element = this.parseNodeBounds(viewHierarchy["accessibility-focused-element"]);
      if (element) {
        element["accessibility-focused"] = true;
        return element;
      }
    }

    // Fallback: traverse the hierarchy to find the accessibility-focused element
    return this.findElementByProperty(viewHierarchy, "accessibility-focused");
  }

  private findElementByProperty(viewHierarchy: any, propertyName: string): Element | null {
    if (!viewHierarchy) {
      return null;
    }

    let foundElement: Element | null = null;

    const traverseNode = (node: any): void => {
      if (foundElement) {
        return;
      }

      const props = node.$ || node;
      if (props[propertyName] === "true" || props[propertyName] === true) {
        const element = this.parseNodeBounds(node);
        if (element) {
          element[propertyName] = true;
          foundElement = element;
          return;
        }
      }

      if (node.node) {
        const children = Array.isArray(node.node) ? node.node : [node.node];
        for (const child of children) {
          traverseNode(child);
          if (foundElement) {
            break;
          }
        }
      }
    };

    if (viewHierarchy.hierarchy) {
      traverseNode(viewHierarchy.hierarchy);
    }

    return foundElement;
  }

  /**
   * Calculate the center coordinates of an element
   * @param element - The element to calculate center for
   * @returns The center coordinates
   */
  getElementCenter(element: Element): { x: number, y: number } {
    return this.geometry.getElementCenter(element);
  }

  /**
   * Parse a node's bounds into the object bounds format.
   * @param node - The node to parse
   * @returns The node with parsed bounds or null
   */
  parseNodeBounds(node: any): Element | null {
    return this.parser.parseNodeBounds(node);
  }

  /**
   * Traverse the view hierarchy and process each node with a provided function
   * @param node - The node to start traversal from
   * @param processNode - Function to process each node
   */
  traverseViewHierarchy(node: any, processNode: (node: any) => void): void {
    this.parser.traverseNode(node, processNode);
  }

  cleanNodeProperties(node: any): any {
    const result: any = {};
    const allowedProperties = [
      "text",
      "resourceId",
      "resource-id",
      "viewId",
      "view-id",
      "contentDesc",
      "content-desc",
      "clickable",
      "long-clickable",
      "scrollable",
      "enabled",
      "focusable",
      "focused",
      "accessibility-focused",
      "checkable",
      "checked",
      "selected",
      "bounds",
      "test-tag",
      "unique-id",
      "collection-row-index",
      "collection-column-index",
      "visible-to-user",
      "container-title",
      "role",
      "state-description",
      "error-message",
      "hint-text",
      "tooltip-text",
      "pane-title",
      "live-region",
      "collection-info",
      "collection-item-info",
      "range-info",
      "input-type",
      "actions",
      "extras",
      "occlusionState",
      "occludedBy",
      "occludedByViewId",
      "recomposition",
      "recompositionMetrics"
    ];

    if (node["$"]) {
      const cleanedProps: any = {};
      for (const key in node.$) {
        if (allowedProperties.includes(key)) {
          const normalizedKey = key === "resourceId" ? "resource-id" : key === "contentDesc" ? "content-desc" : key;
          if (node.$[key] === "") {continue;}
          if (key === "enabled" && (node.$[key] === true || node.$[key] === "true")) {continue;}
          if (key !== "enabled" && (node.$[key] === false || node.$[key] === "false")) {continue;}
          cleanedProps[normalizedKey] = node.$[key];
        }
      }

      if (Object.keys(cleanedProps).length > 0) {
        for (const key in cleanedProps) {
          result[key] = cleanedProps[key];
        }
      }

      for (const key in node) {
        if (key !== "$" && key !== "node") {
          result[key] = node[key];
        }
      }
    } else {
      for (const key in node) {
        if (key === "node") {continue;}
        if (!allowedProperties.includes(key)) {continue;}
        if (node[key] === "") {continue;}
        if (key === "enabled" && (node[key] === true || node[key] === "true")) {continue;}
        if (key !== "enabled" && (node[key] === false || node[key] === "false")) {continue;}
        result[key] = node[key];
      }
    }

    return result;
  }
}
