/**
 * Applies an incoming accessibility hierarchy frame: resolves correlated waiters, maintains the
 * shared cache, feeds the observation stream and layout telemetry, and drives hierarchy-based
 * navigation detection. Extracted from `AndroidCtrlProxyClient` (#11846); behaviour is unchanged.
 */
import { isDeepStrictEqual } from "node:util";
import { nodeAttributes } from "../../../models";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import { getPerformanceMonitor } from "../../performance/PerformanceMonitor";
import { TelemetryRecorder } from "../../telemetry/TelemetryRecorder";
import type { NavigationGraphManager } from "../../navigation/NavigationGraphManager";
import type { HierarchyNavigationDetector } from "../../navigation/HierarchyNavigationDetector";
import { appWindowsOnly } from "../hierarchyLayer";
import { linkWindowRoots } from "../linkWindowRoots";
import type { CtrlProxyHierarchy } from "./CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  AccessibilityNode,
  AndroidPerfTiming,
  CachedHierarchy,
} from "./types";

/** Client-backed accessors resolve live state on every use, including after awaits. */
export interface AndroidHierarchyUpdateContext {
  readonly timer: Pick<Timer, "now">;
  readonly deviceId: string;
  readonly transientObserver: boolean;
  readonly hierarchy: Pick<
    CtrlProxyHierarchy,
    "resolvePendingHierarchy" | "hasSeenCorrelatedFrames"
  >;
  readonly observerHierarchyRequestIds: Map<string, boolean>;
  readonly hierarchyObservationStreamSuppressions: Map<string, NodeJS.Timeout>;
  readonly sdkNavigationAppIds: ReadonlySet<string>;
  cachedHierarchy: CachedHierarchy | null;
  lastForegroundPackage: string | null;
  removeHierarchyObservationStreamSuppression(requestId: string): boolean;
  updateCachedScreenDimensions(hierarchy: AccessibilityHierarchy): void;
  pushHierarchyToObservationStream(hierarchy: AccessibilityHierarchy, frameContext?: string): void;
  startScreenshotBackoff(): void;
  getNavigationGraphManager(): Pick<NavigationGraphManager, "recordAppForeground">;
  ensureBuildContext(packageName: string): void;
  getHierarchyNavigationDetector(): HierarchyNavigationDetector;
}

export class AndroidHierarchyUpdateHandler {
  private lastLayoutTelemetryTimestamp = 0;

  constructor(private readonly context: AndroidHierarchyUpdateContext) {}

  handle(
    data: AccessibilityHierarchy,
    perfTiming?: AndroidPerfTiming[],
    frameContext?: string,
    requestId?: string | null,
  ): void {
    const { context: ctx } = this;
    const now = ctx.timer.now();
    logger.debug(
      `[CTRL_PROXY] Received hierarchy update (updatedAt: ${data.updatedAt}, receivedAt: ${now})`,
    );

    const incomingHierarchy: CachedHierarchy = {
      hierarchy: data,
      receivedAt: now,
      fresh: true,
      requestId,
      perfTiming,
      frameContext,
    };
    // A must-deliver correlated frame can leave the runner after a newer coalesced push.
    // Complete its own waiter, but do not regress the shared cache or observation stream.
    const observerResponse = !!requestId && ctx.observerHierarchyRequestIds.has(requestId);
    const isolatedObserverResponse =
      observerResponse && ctx.observerHierarchyRequestIds.get(requestId!) === true;
    ctx.hierarchy.resolvePendingHierarchy(requestId, incomingHierarchy);
    // Consume correlated responses even when too old for the shared cache or observer-only.
    const suppressObservationStreamPush =
      !!requestId && ctx.removeHierarchyObservationStreamSuppression(requestId);
    if (observerResponse) {
      ctx.observerHierarchyRequestIds.delete(requestId);
      if (this.observerFrameIsDiscarded(data, isolatedObserverResponse)) {
        return;
      }
    }
    if (ctx.transientObserver) {
      return;
    }
    if (ctx.cachedHierarchy && data.updatedAt < ctx.cachedHierarchy.hierarchy.updatedAt) {
      return;
    }

    // Mark previous cache as stale
    if (ctx.cachedHierarchy) {
      ctx.cachedHierarchy.fresh = false;
    }

    // Update cache with fresh data
    ctx.cachedHierarchy = incomingHierarchy;

    // Update cached screen dimensions
    ctx.updateCachedScreenDimensions(data);

    this.publishObservationFrame(data, frameContext, requestId, suppressObservationStreamPush);

    this.trackForegroundPackage(data);

    // Record layout telemetry (throttled to max 1 per 500ms)
    if (now - this.lastLayoutTelemetryTimestamp >= 500) {
      this.lastLayoutTelemetryTimestamp = now;
      this.recordLayoutTelemetry(data, now);
    }

    this.notifyNavigationDetector(data);
  }

  private publishObservationFrame(
    data: AccessibilityHierarchy,
    frameContext: string | undefined,
    requestId: string | null | undefined,
    suppressInitial: boolean,
  ): void {
    const { context: ctx } = this;
    let suppress = suppressInitial;
    // Old APKs have no echo capability advertisement. Until the first correlated frame on a
    // fresh connection, an idless broadcast can still consume the oldest token (legacy behavior).
    // Once ANY echoed id is seen, idless/foreign frames never consume another request's token.
    // Keep legacy consumption after the cache/observer guards, exactly as the anonymous Set was.
    if (!requestId && !ctx.hierarchy.hasSeenCorrelatedFrames()) {
      const oldestId = ctx.hierarchyObservationStreamSuppressions.keys().next().value;
      suppress =
        oldestId !== undefined && ctx.removeHierarchyObservationStreamSuppression(oldestId);
    }
    if (!suppress) {
      // Push to observation stream
      ctx.pushHierarchyToObservationStream(data, frameContext);

      // Start screenshot backoff
      ctx.startScreenshotBackoff();
    } else {
      logger.debug(
        "[CTRL_PROXY] Suppressed hierarchy observation stream push for explicit initial-frame request",
      );
    }
  }

  private observerFrameIsDiscarded(
    data: AccessibilityHierarchy,
    isolatedObserverResponse: boolean,
  ): boolean {
    const { context: ctx } = this;
    return (
      ctx.transientObserver ||
      // Aggregate and explicit-panel observer frames cannot seed the owner's active frame.
      isolatedObserverResponse ||
      (ctx.cachedHierarchy !== null &&
        isDeepStrictEqual(
          {
            hierarchy: data.hierarchy,
            packageName: data.packageName,
            windows: data.windows,
            screenWidth: data.screenWidth,
            screenHeight: data.screenHeight,
            rotation: data.rotation,
            displayId: data.displayId,
          },
          {
            hierarchy: ctx.cachedHierarchy.hierarchy.hierarchy,
            packageName: ctx.cachedHierarchy.hierarchy.packageName,
            windows: ctx.cachedHierarchy.hierarchy.windows,
            screenWidth: ctx.cachedHierarchy.hierarchy.screenWidth,
            screenHeight: ctx.cachedHierarchy.hierarchy.screenHeight,
            rotation: ctx.cachedHierarchy.hierarchy.rotation,
            displayId: ctx.cachedHierarchy.hierarchy.displayId,
          },
        ))
    );
  }

  private trackForegroundPackage(data: AccessibilityHierarchy): void {
    const { context: ctx } = this;
    // Track foreground package for context and start performance monitoring
    if (data.packageName && data.packageName !== ctx.lastForegroundPackage) {
      ctx.lastForegroundPackage = data.packageName;
      // Start performance monitoring for this device/package
      const monitor = getPerformanceMonitor();
      monitor.startMonitoring(ctx.deviceId, data.packageName);
    }
  }

  private recordLayoutTelemetry(data: AccessibilityHierarchy, now: number): void {
    const { context: ctx } = this;
    const recorder = TelemetryRecorder.getInstance();
    recorder.setContext(ctx.deviceId, null);
    const screenName = data.foregroundActivity ?? data.packageName ?? null;
    const windowCount = data.windows?.length ?? 0;
    // Include a compact hierarchy tree (~2-5KB) with just the display properties.
    // The full hierarchy (~10-50KB with bounds/states/extras) is available via
    // the observation stream and would cause excessive traffic at 500ms intervals.
    const compactHierarchy = data.hierarchy ? { node: compactifyNode(data.hierarchy) } : null;
    recorder
      .recordLayoutEvent({
        timestamp: now,
        applicationId: data.packageName ?? null,
        subType: "hierarchy_change",
        composableName: null,
        composableId: null,
        recompositionCount: null,
        durationMs: null,
        likelyCause: null,
        detailsJson: JSON.stringify({
          screenName,
          windowCount,
          foregroundActivity: data.foregroundActivity ?? null,
          hierarchy: compactHierarchy,
        }),
        screenName,
      })
      .catch((error) => {
        logger.warn(`[CTRL_PROXY] Layout telemetry failed: ${errorMessage(error)}`, error);
      });
  }

  private notifyNavigationDetector(data: AccessibilityHierarchy): void {
    const { context: ctx } = this;
    // Notify hierarchy navigation detector. Screen identity follows the app windows only
    // (#9305): AutoMobile's own prototype is removed and the capture attributed to the app behind it,
    // so showing, paging or dismissing a prototype records no navigation.
    const appCapture = appWindowsOnly(data);
    const navigationPackage = this.resolveHierarchyPackage(appCapture);
    if (!appCapture.hierarchy) {
      logger.warn("[CTRL_PROXY] Skipping navigation detection: hierarchy missing");
    } else if (data.error) {
      logger.warn(`[CTRL_PROXY] Skipping navigation detection due to error: ${data.error}`);
    } else if (!this.shouldUseHierarchyNavigation(navigationPackage)) {
      logger.debug(`[CTRL_PROXY] Skipping hierarchy navigation for SDK app: ${navigationPackage}`);
      // The app may be back in front without a navigation event (#10193). The signal names this
      // device: on the shared global manager another device's tick must not switch the app.
      if (navigationPackage) {
        ctx
          .getNavigationGraphManager()
          .recordAppForeground(navigationPackage, ctx.deviceId)
          .catch((error) =>
            logger.warn(`[CTRL_PROXY] SDK app foreground signal failed: ${errorMessage(error)}`),
          );
      }
    } else {
      // Resolve build/device provenance for hierarchy-driven reaches too (#4984):
      // non-SDK apps never emit navigation_event, so this is the only path that gives
      // them a real build key instead of the default/legacy one.
      if (navigationPackage) {
        ctx.ensureBuildContext(navigationPackage);
      }
      ctx.getHierarchyNavigationDetector().onHierarchyUpdate({
        ...appCapture,
        packageName: navigationPackage,
      });
    }
  }

  private resolveHierarchyPackage(data: AccessibilityHierarchy): string | undefined {
    if (data.packageName?.trim()) {
      return data.packageName.trim();
    }
    const windows = (linkWindowRoots(data.hierarchy, data.windows) ?? []).filter(
      (window) =>
        data.displayId === undefined ||
        data.displayId === null ||
        window.displayId === undefined ||
        window.displayId === null ||
        window.displayId === data.displayId,
    );
    // An IME can own focus above the app. Prefer a focused non-IME surface
    // (including system dialogs), then the active/top application window.
    const appWindows = windows.filter((entry) => entry.type === 1);
    const window =
      windows.find((entry) => entry.isFocused && entry.type !== 2) ??
      appWindows.find((entry) => entry.isActive) ??
      appWindows.sort((left, right) => (right.windowLayer ?? 0) - (left.windowLayer ?? 0))[0];
    const attributes = window?.hierarchy ? nodeAttributes(window.hierarchy) : {};
    // Do not borrow a different root's identity when the selected window is unknown.
    const candidates = window
      ? [window.packageName, attributes.packageName, attributes.package]
      : [data.hierarchy?.packageName];
    return candidates
      .flatMap((value) => (typeof value === "string" ? [value.trim()] : []))
      .find((value) => value.length > 0);
  }

  private shouldUseHierarchyNavigation(packageName?: string): boolean {
    if (!packageName) {
      return true;
    }
    return !this.context.sdkNavigationAppIds.has(packageName);
  }
}

/**
 * Create a compact representation of an AccessibilityNode tree for telemetry.
 * Strips bounds, states, extras — keeps only className, resource-id, text,
 * content-desc, scrollable, and children. Typically ~2-5KB vs 10-50KB full.
 */
export function compactifyNode(node: AccessibilityNode): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  if (node.className) {
    compact.className = node.className;
  }
  if (node["resource-id"]) {
    compact["resource-id"] = node["resource-id"];
  }
  if (node.text) {
    compact.text = node.text;
  }
  if (node["content-desc"]) {
    compact["content-desc"] = node["content-desc"];
  }
  if (node.scrollable === "true") {
    compact.scrollable = "true";
  }

  if (node.node) {
    const children = Array.isArray(node.node) ? node.node : [node.node];
    compact.node = children.map(compactifyNode);
  }
  return compact;
}
