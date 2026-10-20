import { errorMessage } from "../../../utils/describeUnknownError";
import { SdkCapabilityProbeSupersededError } from "./SdkCapabilityProbeSupersededError";
import type { Timer } from "../../../utils/SystemTimer";
import type {
  CtrlProxyNode,
  CtrlProxyPerfTiming,
  CtrlProxyPerformanceSnapshot,
  XCTestHierarchy,
} from "./types";
import type { CtrlProxyBuildContext } from "./CtrlProxyBuildContext";
import type { CtrlProxySdkCapabilities } from "./CtrlProxySdkCapabilities";
import type {
  HierarchyNavigationDetector,
  HierarchyNavigationUpdateMetrics,
} from "../../navigation/HierarchyNavigationDetector";
import type { AccessibilityHierarchy } from "../../navigation/ScreenFingerprint";
import {
  getDeviceDataStreamServer,
  type PerformanceStreamData,
} from "../../../daemon/deviceDataStreamSocketServer";
import { getPerformanceMonitor } from "../../performance/PerformanceMonitor";
import { appWindowsOnly } from "../hierarchyLayer";
import { logger } from "../../../utils/logger";
interface HierarchyTelemetryHost {
  readonly timer: Timer;
  readonly deviceId: string;
  readonly sdkCapability: Pick<
    CtrlProxySdkCapabilities,
    "invalidateSdkCapabilities" | "refreshSdkCapabilitiesAndSync"
  >;
  readonly buildContext: Pick<CtrlProxyBuildContext, "ensureBuildContext">;
  lastForegroundBundleId: string | null;
  getHierarchyNavigationDetector(): HierarchyNavigationDetector;
}

function numberOrDefault(value: number | null | undefined): number {
  return value ?? 0;
}

function nullWhenAbsent<T>(value: T | null | undefined): T | null {
  return value ?? null;
}
/** Converts hierarchy navigation and runner telemetry without owning transport lifecycle. */
export class CtrlProxyHierarchyTelemetry {
  constructor(private readonly host: HierarchyTelemetryHost) {}

  /**
   * Handle performance update push messages from iOS CtrlProxy.
   * Converts the iOS performance snapshot to PerformanceStreamData and pushes to IDE.
   */
  handlePerformanceUpdate(snapshot: CtrlProxyPerformanceSnapshot): void {
    const server = getDeviceDataStreamServer();
    if (!server) {
      return;
    }

    // Convert iOS performance snapshot to PerformanceStreamData format
    const fps = numberOrDefault(snapshot.fps);
    const streamData: PerformanceStreamData = {
      fps,
      frameTimeMs: numberOrDefault(snapshot.frameTimeMs),
      jankFrames: numberOrDefault(snapshot.jankFrames),
      droppedFrames: 0, // iOS doesn't report this separately
      memoryUsageMb: numberOrDefault(snapshot.memoryUsageMb),
      cpuUsagePercent: numberOrDefault(snapshot.cpuUsagePercent),
      touchLatencyMs: nullWhenAbsent(snapshot.touchLatencyMs),
      timeToInteractiveMs: nullWhenAbsent(snapshot.ttiMs),
      screenName: nullWhenAbsent(snapshot.screenName),
      isResponsive: fps >= 50, // Consider responsive if FPS >= 50
      recompositionCount: null,
      recompositionRate: null,
    };

    // NOTE: this CtrlProxy snapshot is intentionally NOT fed into the observe
    // `perfSnapshot` buffer. Its CADisplayLink fps/frame/jank measure the
    // XCUITest *runner* process's own main-thread cadence, and its cpu/memory
    // (task_info on the runner) describe the runner — none of it is the app
    // under test. The app's real CPU/memory reach the buffer via
    // PerformanceMonitor's host-side sampler (ps/simctl by bundle id). Feeding
    // runner-cadence numbers here would present runner health as app perf.
    // A real per-app iOS source is tracked in #5078; it still flows to the IDE
    // stream below (unchanged existing behavior).
    try {
      server.pushPerformanceUpdate(this.host.deviceId, streamData);
      // Log occasionally to avoid spam
      if (this.host.timer.now() % 5000 < 600) {
        logger.debug(
          `[IOSCtrlProxyClient] iOS FPS: ${streamData.fps.toFixed(1)}, frameTime: ${streamData.frameTimeMs.toFixed(1)}ms, memory: ${streamData.memoryUsageMb.toFixed(1)}MB`,
        );
      }
    } catch (error) {
      logger.warn(`[IOSCtrlProxyClient] Failed to push performance update: ${error}`);
    }
  }

  handleHierarchyUpdateForNavigation(
    hierarchy: XCTestHierarchy,
    perfTiming?: CtrlProxyPerfTiming | CtrlProxyPerfTiming[],
  ): void {
    if (!hierarchy.hierarchy) {
      logger.warn(
        "[IOSCtrlProxyClient] Skipping navigation detection: hierarchy missing in update",
      );
      return;
    }

    if (hierarchy.error) {
      logger.warn(
        `[IOSCtrlProxyClient] Skipping navigation detection due to hierarchy error: ${hierarchy.error}`,
      );
      return;
    }

    // Track foreground bundle and start performance monitoring when app changes
    const bundleId = hierarchy.packageName;
    if (bundleId) {
      this.host.buildContext.ensureBuildContext(bundleId);
    }
    logger.debug(
      `[IOSCtrlProxyClient] Hierarchy update - bundleId: "${bundleId}", lastForeground: "${this.host.lastForegroundBundleId}"`,
    );
    if (bundleId && bundleId !== this.host.lastForegroundBundleId) {
      this.host.lastForegroundBundleId = bundleId;
      this.host.sdkCapability.invalidateSdkCapabilities();
      void this.host.sdkCapability.refreshSdkCapabilitiesAndSync().catch((error) => {
        if (error instanceof SdkCapabilityProbeSupersededError) {
          // The newer foreground generation refreshes its own capabilities.
          logger.debug(`[IOSCtrlProxyClient] SDK capability refresh superseded: ${error.message}`);
          return;
        }
        logger.warn(
          `[IOSCtrlProxyClient] SDK capability refresh after app change failed: ${errorMessage(error)}`,
          error,
        );
      });
      // Start performance monitoring for this device/bundle
      const monitor = getPerformanceMonitor();
      monitor.startMonitoring(this.host.deviceId, bundleId, "ios");
      logger.info(
        `[IOSCtrlProxyClient] Started performance monitoring for ${bundleId} on ${this.host.deviceId}`,
      );
    }

    const conversionStart = this.host.timer.now();
    // Screen identity follows the app's windows only (#9305): the prototype agent's UIWindow is
    // removed, so showing, paging or dismissing a prototype records no navigation.
    const convertedHierarchy = this.convertHierarchyForNavigation(appWindowsOnly(hierarchy));
    const conversionMs = this.host.timer.now() - conversionStart;

    const metrics: HierarchyNavigationUpdateMetrics = {
      source: "ios",
      conversionMs,
      externalTiming: perfTiming,
    };

    this.host.getHierarchyNavigationDetector().onHierarchyUpdate(convertedHierarchy, metrics);
  }

  private convertHierarchyForNavigation(hierarchy: XCTestHierarchy): AccessibilityHierarchy {
    return {
      updatedAt: hierarchy.updatedAt,
      packageName: hierarchy.packageName,
      hierarchy: this.convertNodeForNavigation(
        hierarchy.hierarchy,
      ) as AccessibilityHierarchy["hierarchy"],
    };
  }

  private convertNodeForNavigation(
    node: CtrlProxyNode | CtrlProxyNode[],
  ): Record<string, unknown> | Record<string, unknown>[] {
    if (Array.isArray(node)) {
      return node.flatMap((child) => {
        const converted = this.convertNodeForNavigation(child);
        return Array.isArray(converted) ? converted : [converted];
      });
    }

    const converted: Record<string, unknown> = {};

    const contentDesc = this.readNodeField<string>(node, "contentDesc", "content-desc");
    const resourceId = this.readNodeField<string>(node, "resourceId", "resource-id");
    const testTag = this.readNodeField<string>(node, "testTag", "test-tag");
    const viewId = this.readNodeField<string>(node, "viewId", "view-id");

    if (node.text) {
      converted.text = node.text;
    }
    if (contentDesc) {
      converted["content-desc"] = contentDesc;
    }
    if (resourceId) {
      converted["resource-id"] = resourceId;
    }
    if (testTag) {
      converted["test-tag"] = testTag;
    }
    if (viewId) {
      converted["view-id"] = viewId;
    }
    if (node.className) {
      converted.className = node.className;
    }
    if (node.scrollable) {
      converted.scrollable = node.scrollable;
    }
    if (node.selected) {
      converted.selected = node.selected;
    }

    if (node.node) {
      converted.node = this.convertNodeForNavigation(node.node);
    }

    return converted;
  }

  private readNodeField<T>(
    node: CtrlProxyNode,
    camelKey: keyof CtrlProxyNode,
    dashedKey?: string,
  ): T | undefined {
    const record = node as Record<string, unknown>;
    if (record[camelKey as string] !== undefined) {
      return record[camelKey as string] as T;
    }
    if (dashedKey && record[dashedKey] !== undefined) {
      return record[dashedKey] as T;
    }
    return undefined;
  }
}
