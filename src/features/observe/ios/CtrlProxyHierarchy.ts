/**
 * CtrlProxy iOSHierarchy - Delegate for hierarchy operations.
 *
 * This delegate handles hierarchy retrieval, caching, and conversion
 * via the iOS CtrlProxy iOS WebSocket API.
 */

import type { ViewHierarchyResult } from "../../../models";
import { screenScaleMetadataSpread } from "../../../models/ScreenScaleMetadata";
import type { ViewHierarchyQueryOptions } from "../../../models/ViewHierarchyQueryOptions";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { logger } from "../../../utils/logger";
import { hasIosHeaderTrait } from "./semanticRoles";
import { maxObservationAgeMs } from "../observationFreshness";
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

const GENERATED_VIEW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
   *
   * The entry is deliberately kept rather than nulled: `getLatestHierarchy` still
   * returns it as an explicitly-stale fallback when a fresh fetch is impossible
   * (disconnected/reconnecting runner). Use `IOSCtrlProxyClient.clearCache()` when
   * the cached data must not be served at all — e.g. after an app data wipe.
   */
  invalidateCache(): void {
    const cached = this.context.getCachedHierarchy();
    if (cached) {
      logger.debug("[CTRL_PROXY] Invalidating cached hierarchy");
      this.context.setCachedHierarchy({ ...cached, fresh: false });
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

    const converted = this.convertToViewHierarchyResult(response.hierarchy);
    if (response.frameContext !== undefined) {
      converted.frameContext = response.frameContext;
    }
    // Carry the delegate's own verdict to the caller. `getLatestHierarchy` has
    // always known whether it verified this tree against the device or served a
    // cache entry unverified, and this boundary used to drop that fact on the
    // floor — which is how `ObserveScreen` ended up unable to tell the two apart
    // and defaulted to calling everything fresh.
    converted.fresh = response.fresh;
    return converted;
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
    let cachedCaptureAgeMs: number | undefined;
    if (cachedHierarchy) {
      // `updatedAt` identifies a capture but lives in the device clock domain,
      // so it cannot safely be subtracted from host time. Instead, age the first
      // host sighting of that capture. The client preserves it for repeated
      // deliveries of an unchanged `updatedAt`.
      cachedCaptureAgeMs = this.context.timer.now() -
        (cachedHierarchy.captureReceivedAt ?? cachedHierarchy.receivedAt);
      const cacheAge = cachedCaptureAgeMs;
      // `fresh` is honoured as well as elapsed time: without it, invalidateCache()
      // would be an observable no-op inside the TTL (issue #4193).
      const isFresh = cachedHierarchy.fresh && cacheAge < this.context.cacheFreshTtlMs;
      const meetsMinTimestamp = minTimestamp === 0 || cachedHierarchy.hierarchy.updatedAt >= minTimestamp;

      if (isFresh && meetsMinTimestamp) {
        if (cachedHierarchy.hierarchy.packageName) {
          this.lastKnownPackageName = cachedHierarchy.hierarchy.packageName;
        }
        return {
          hierarchy: cachedHierarchy.hierarchy,
          fresh: true,
          updatedAt: cachedHierarchy.hierarchy.updatedAt,
          perfTiming: cachedHierarchy.perfTiming,
          frameContext: cachedHierarchy.frameContext,
        };
      }
    }

    // Need fresh data.
    //
    // An explicitly invalidated entry forces the sync fetch even when the caller
    // passed skipWaitForFresh. Observe's default path is skipWaitForFresh=true, so
    // without this the stale fallback below would hand back the very entry the
    // invalidation was meant to retire — e.g. the unfiltered snapshot that
    // HierarchyCollector.collectRaw caches and then invalidates (issue #4193).
    // Nulling the cache instead is not an option here: under skipWaitForFresh a
    // missing cache yields no hierarchy at all rather than a refetch.
    const cacheInvalidated = cachedHierarchy !== null && !cachedHierarchy.fresh;
    // A cache whose CAPTURE timestamp is past the freshness budget must be
    // re-verified before it may be served, even on the `skipWaitForFresh` path —
    // which is `observe`'s default (ObserveScreen.execute: `skipWaitForFresh ??
    // true`). Without this clause the default path reaches neither branch below
    // and falls straight through to the stale fallback, so the ONLY thing that
    // could ever advance this cache was an unsolicited push. The runner
    // deliberately does not push when its structural hash is unchanged
    // (CtrlProxy.swift, `case .unchanged: // Don't broadcast unchanged results`),
    // so a screen that is merely sitting still — or a runner whose extraction
    // has wedged — leaves the entry frozen and every subsequent `observe`
    // re-serves it, forever. That is the "no known mechanism to recover a stale
    // tree" symptom: there was no code path that asked.
    const cacheStale = cachedCaptureAgeMs !== undefined && cachedCaptureAgeMs > maxObservationAgeMs();
    if (!skipWaitForFresh || cacheInvalidated || cacheStale) {
      if (cacheStale && skipWaitForFresh && !cacheInvalidated) {
        logger.debug(
          `[CTRL_PROXY] Cached hierarchy is ${cachedCaptureAgeMs}ms old (budget ${maxObservationAgeMs()}ms); forcing a synchronous re-verification`
        );
      }
      const result = await this.requestHierarchySync(perf, false, undefined, timeout);
      if (result) {
        if (result.hierarchy.packageName) {
          this.lastKnownPackageName = result.hierarchy.packageName;
        }
        return {
          hierarchy: result.hierarchy,
          fresh: true,
          updatedAt: result.hierarchy.updatedAt,
          perfTiming: result.perfTiming,
          frameContext: result.frameContext,
        };
      }

    }

    const reconnectStatus = this.context.getReconnectStatus?.() ?? undefined;

    // Re-read the cache: `cachedHierarchy` was captured before the awaited sync,
    // and an unsolicited hierarchy_update push handled by
    // IOSCtrlProxyClient.processMessage can have replaced it while that request
    // was in flight. Serving the pre-await snapshot would hand back the very
    // entry an invalidation was meant to retire even though newer data arrived.
    // Note this only re-reads; it must never null the cache, because under
    // skipWaitForFresh a missing cache yields no hierarchy at all (#4193/#4230).
    const fallbackHierarchy = this.context.getCachedHierarchy() ?? cachedHierarchy;

    // Return cached (stale) data if available.
    //
    // This return is the last honest resort, not a normal path: reaching it
    // means the runner did not answer a synchronous hierarchy request within
    // `timeout`. It is reported as `fresh: false`, which now survives all the
    // way to `ObserveResult.freshness` (see getAccessibilityHierarchy) instead
    // of being overwritten with a constant `true` by ObserveScreen.
    if (fallbackHierarchy) {
      const fallbackCapturedAt = fallbackHierarchy.hierarchy.updatedAt;
      logger.warn(
        `[CTRL_PROXY] Serving an UNVERIFIED cached hierarchy: the runner did not answer a synchronous ` +
        `hierarchy request within ${timeout}ms. Tree was captured ` +
        `${typeof fallbackCapturedAt === "number" ? this.context.timer.now() - fallbackCapturedAt : "?"}ms ago. ` +
        `Reporting freshness.isFresh=false.`
      );
      // Update tracking from cache — it may have been refreshed by a WebSocket push
      if (fallbackHierarchy.hierarchy.packageName) {
        if (this.lastKnownPackageName && fallbackHierarchy.hierarchy.packageName !== this.lastKnownPackageName) {
          logger.warn(`[CTRL_PROXY] Stale cache packageName differs: cached=${fallbackHierarchy.hierarchy.packageName}, lastKnown=${this.lastKnownPackageName}`);
        }
        this.lastKnownPackageName = fallbackHierarchy.hierarchy.packageName;
      }
      return {
        hierarchy: fallbackHierarchy.hierarchy,
        fresh: false,
        updatedAt: fallbackHierarchy.hierarchy.updatedAt,
        perfTiming: fallbackHierarchy.perfTiming,
        frameContext: fallbackHierarchy.frameContext,
        reconnectStatus,
        reconnectMessage: reconnectStatus
          ? this.buildReconnectMessage(reconnectStatus.retryAfterSeconds)
          : undefined
      };
    }

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
  ): Promise<{ hierarchy: XCTestHierarchy; perfTiming?: CtrlProxyPerfTiming; frameContext?: string } | null> {
    if (!await this.context.ensureConnected(perf)) {
      return null;
    }

    const requestId = this.context.requestManager.generateId("hierarchy");
    if (suppressObservationStreamPush) {
      this.context.suppressHierarchyObservationStreamPush?.(requestId, timeoutMs);
    }
    const promise = this.context.requestManager.register<{
      hierarchy?: XCTestHierarchy;
      perfTiming?: CtrlProxyPerfTiming;
      frameContext?: string;
    }>(
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
      const now = this.context.timer.now();
      const previous = this.context.getCachedHierarchy();
      const newCache: CachedHierarchy = {
        hierarchy: result.hierarchy,
        receivedAt: now,
        captureReceivedAt: this.captureReceivedAt(result.hierarchy, previous, now),
        fresh: true,
        perfTiming: result.perfTiming,
        frameContext: result.frameContext,
      };
      this.context.setCachedHierarchy(newCache);

      return {
        hierarchy: result.hierarchy,
        perfTiming: result.perfTiming,
        frameContext: result.frameContext,
      };
    }

    return null;
  }

  private captureReceivedAt(
    hierarchy: XCTestHierarchy,
    previous: CachedHierarchy | null,
    now: number,
  ): number {
    const sameCapture = previous?.hierarchy.updatedAt === hierarchy.updatedAt
      ? previous
      : undefined;
    return sameCapture?.captureReceivedAt ?? sameCapture?.receivedAt ?? now;
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
      // Additive scale metadata (#4548): UIScreen.nativeScale + physical screenshot pixel
      // dimensions. All-or-nothing via the shared validator (same rule as client retention): the
      // three keys are spread only when the whole tuple is complete-finite-positive, and omitted
      // entirely otherwise — so payloads from pre-#4548 runners stay byte-identical.
      ...screenScaleMetadataSpread(hierarchy),
      rotation: hierarchy.rotation,
      systemInsets: hierarchy.systemInsets,
      insets: hierarchy.insets,
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
    if (hasIosHeaderTrait(node.extras)) {
      attrs["role"] = "heading";
    } else if (node.role) {
      attrs["role"] = node.role;
    }
    if (stateDescription) {attrs["state-description"] = stateDescription;}
    if (errorMessage) {attrs["error-message"] = errorMessage;}
    if (hintText) {attrs["hint-text"] = hintText;}
    if (viewId) {attrs["view-id"] = viewId;}
    if (node.actions && node.actions.length > 0) {attrs["actions"] = node.actions;}

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
  private hasContentProperties(attrs: Record<string, unknown>): boolean {
    return Boolean(
      (attrs["text"] && attrs["text"] !== "") ||
      (attrs["value"] && attrs["value"] !== "") ||
      (attrs["resource-id"] && attrs["resource-id"] !== "") ||
      (attrs["content-desc"] && attrs["content-desc"] !== "") ||
      (attrs["test-tag"] && attrs["test-tag"] !== "") ||
      (attrs["role"] && attrs["role"] !== "") ||
      this.hasMeaningfulViewId(attrs)
    );
  }

  /**
   * Check if a node has meaningful interaction properties
   * Note: iOS marks many containers as clickable, so we're more selective here
   */
  private hasInteractionProperties(attrs: Record<string, unknown>): boolean {
    return Boolean(
      attrs["scrollable"] === "true" ||
      attrs["focused"] === "true" ||
      attrs["accessibility-focused"] === "true" ||
      attrs["selected"] === "true" ||
      attrs["checked"] === "true"
    );
  }

  /**
   * Check if a node is a structural wrapper (UIView with no meaningful properties)
   */
  private isStructuralWrapper(attrs: Record<string, unknown>, hasChildren: boolean): boolean {
    const className = typeof attrs["class"] === "string" ? attrs["class"] : "";
    const isContainerClass = className === "UIWindow" || className === "UIView" || className === "UIImageView";

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
  private cleanAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
    const cleaned: Record<string, unknown> = {};
    const booleanFields = ["clickable", "enabled", "focusable", "focused", "accessibility-focused", "scrollable",
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
    const compactedChildren = this.dropRedundantStaticTextChildren(attrs, filteredChildren);
    const dedupedChildren = this.dedupeNoiseSiblings(compactedChildren);

    // Root node is always kept
    if (isRoot) {
      const cleanedAttrs = this.cleanAttributes(attrs);
      const result: ConvertedNode = { $: cleanedAttrs };
      if (node.extras) { result.extras = node.extras; }
      if (dedupedChildren.length > 0) {
        result.node = dedupedChildren;
      }
      return result;
    }

    // Check if this node is a structural wrapper
    if (this.isStructuralWrapper(attrs, dedupedChildren.length > 0)) {
      // Promote children (collapse this wrapper)
      if (dedupedChildren.length > 0) {
        // Return children to be flattened into parent
        return dedupedChildren as unknown as ConvertedNode;
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
    const keepNode = hasContent || hasInteraction || (isClickable && dedupedChildren.length === 0) || dedupedChildren.length > 0;

    if (!keepNode) {
      return null;
    }

    const cleanedAttrs = this.cleanAttributes(attrs);
    const result: ConvertedNode = { $: cleanedAttrs };
    if (node.extras) { result.extras = node.extras; }
    if (dedupedChildren.length > 0) {
      result.node = dedupedChildren;
    }
    return result;
  }

  private dedupeNoiseSiblings(children: ConvertedNode[]): ConvertedNode[] {
    const seen = new Set<string>();
    const result: ConvertedNode[] = [];

    for (const child of children) {
      const key = this.noiseSiblingKey(child);
      if (key) {
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
      }
      result.push(child);
    }

    return result;
  }

  private dropRedundantStaticTextChildren(
    parentAttrs: Record<string, unknown>,
    children: ConvertedNode[]
  ): ConvertedNode[] {
    const parentText = this.normalizedText(parentAttrs["text"]);
    if (!parentText || !this.canOwnStaticText(parentAttrs)) {
      return children;
    }

    return children.filter(child => !this.isRedundantStaticTextChild(parentText, child));
  }

  private canOwnStaticText(attrs: Record<string, unknown>): boolean {
    const role = typeof attrs["role"] === "string" ? attrs["role"] : "";
    return attrs["clickable"] === "true" || role === "button" || role === "link" || role === "listitem";
  }

  private isRedundantStaticTextChild(parentText: string, child: ConvertedNode): boolean {
    if (child.node && child.node.length > 0) {
      return false;
    }
    if (child.extras && Object.keys(child.extras).length > 0) {
      return false;
    }

    const attrs = child.$ ?? {};
    const className = typeof attrs["class"] === "string" ? attrs["class"] : "";
    const role = typeof attrs["role"] === "string" ? attrs["role"] : "";
    if (className !== "UILabel" || (role !== "" && role !== "text")) {
      return false;
    }
    if (this.normalizedText(attrs["text"]) !== parentText) {
      return false;
    }
    if (Array.isArray(attrs["actions"]) && attrs["actions"].length > 0) {
      return false;
    }
    if (this.hasStateProperties(attrs) || this.hasDirectActionProperties(attrs)) {
      return false;
    }

    return !this.hasStandaloneContentProperties(attrs);
  }

  private hasStandaloneContentProperties(attrs: Record<string, unknown>): boolean {
    return Boolean(
      (attrs["value"] && attrs["value"] !== "") ||
      (attrs["resource-id"] && attrs["resource-id"] !== "") ||
      (attrs["content-desc"] && attrs["content-desc"] !== "") ||
      (attrs["test-tag"] && attrs["test-tag"] !== "") ||
      this.hasMeaningfulViewId(attrs)
    );
  }

  private hasMeaningfulViewId(attrs: Record<string, unknown>): boolean {
    const viewId = attrs["view-id"];
    return typeof viewId === "string" &&
      viewId !== "" &&
      !GENERATED_VIEW_ID_PATTERN.test(viewId);
  }

  private hasDirectActionProperties(attrs: Record<string, unknown>): boolean {
    return Boolean(
      attrs["clickable"] === "true" ||
      attrs["focusable"] === "true" ||
      attrs["long-clickable"] === "true" ||
      attrs["checkable"] === "true"
    );
  }

  private hasStateProperties(attrs: Record<string, unknown>): boolean {
    return Boolean(
      attrs["scrollable"] === "true" ||
      attrs["focused"] === "true" ||
      attrs["accessibility-focused"] === "true" ||
      attrs["selected"] === "true" ||
      attrs["checked"] === "true"
    );
  }

  private normalizedText(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }

  private noiseSiblingKey(node: ConvertedNode): string | null {
    if (node.node && node.node.length > 0) {
      return null;
    }
    if (node.extras && Object.keys(node.extras).length > 0) {
      return null;
    }

    const attrs = node.$ ?? {};
    if (Array.isArray(attrs["actions"]) && attrs["actions"].length > 0) {
      return null;
    }
    if (this.hasStateProperties(attrs)) {
      return null;
    }

    const text = typeof attrs["text"] === "string" ? attrs["text"].trim().toLowerCase() : "";
    const isKnownNoise = text.includes("scroll bar") || text === "dictate" || text === "dictation";
    if (!isKnownNoise) {
      return null;
    }

    return JSON.stringify([
      attrs["class"] ?? "",
      attrs["text"] ?? "",
      attrs["resource-id"] ?? "",
      attrs["bounds"] ?? null,
    ]);
  }
}
