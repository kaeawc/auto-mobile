import { logger } from "../../../utils/logger";
import { NoOpPerformanceTracker, PerformanceTracker } from "../../../utils/PerformanceTracker";
import { AndroidCtrlProxyManager } from "../../../utils/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../android";
import { IOSCtrlProxyClient } from "../ios";
import { appendObserveError } from "../ObserveError";
import type { BootedDevice, ObserveResult } from "../../../models";
import type { ViewHierarchyQueryOptions } from "../../../models/ViewHierarchyQueryOptions";
import type { ViewHierarchy } from "../interfaces/ViewHierarchy";
import type { Timer } from "../../../utils/SystemTimer";
import type { AdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { parseBounds } from "../../../utils/bounds";

export interface HierarchyCollectorOptions {
  device: BootedDevice;
  viewHierarchy: ViewHierarchy;
  adb: AdbExecutor;
  adbFactory: AdbClientFactory;
  timer: Timer;
}

/**
 * Collects view hierarchy + raw view hierarchy data into an ObserveResult.
 * Encapsulates Android/iOS branching and structured error reporting.
 */
export class HierarchyCollector {
  constructor(private opts: HierarchyCollectorOptions) {}

  /**
   * Collect view hierarchy and handle errors with accessibility service caching.
   */
  async collect(
    result: ObserveResult,
    queryOptions?: ViewHierarchyQueryOptions,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    skipWaitForFresh: boolean = false,
    minTimestamp: number = 0,
    signal?: AbortSignal,
  ): Promise<void> {
    const { device, viewHierarchy, adb, timer } = this.opts;
    try {
      if (device.platform === "android") {
        await viewHierarchy.configureRecompositionTracking(true, perf);
      }

      const viewHierarchyStart = timer.now();
      const hierarchy = await viewHierarchy.getViewHierarchy(
        queryOptions,
        perf,
        skipWaitForFresh,
        minTimestamp,
        signal,
      );
      logger.debug("Accessibility service availability cached as: true");

      if (hierarchy) {
        result.viewHierarchy = hierarchy;

        // Use the updatedAt from the view hierarchy if available (from accessibility service)
        if (hierarchy.updatedAt) {
          result.updatedAt = hierarchy.updatedAt;
          logger.debug(`Using updatedAt from view hierarchy: ${hierarchy.updatedAt}`);
        }

        const focusedElement = viewHierarchy.findFocusedElement(hierarchy);
        if (focusedElement) {
          result.focusedElement = focusedElement;
          logger.debug(
            `Found focused element: ${focusedElement.text || focusedElement["resource-id"] || "no text/id"}`,
          );
        }

        const accessibilityFocusedElement =
          viewHierarchy.findAccessibilityFocusedElement(hierarchy);
        if (accessibilityFocusedElement) {
          result.accessibilityFocusedElement = accessibilityFocusedElement;
          logger.debug(
            `Found accessibility-focused element: ${accessibilityFocusedElement.text || accessibilityFocusedElement["resource-id"] || accessibilityFocusedElement["content-desc"] || "no text/id/desc"}`,
          );
        }

        // Intent chooser detection (inlined; logs but does not append a structured error on failure)
        try {
          const intentChooserDetected = hierarchy.intentChooserDetected;
          result.intentChooserDetected = intentChooserDetected;
          if (intentChooserDetected) {
            logger.debug("[ObserveScreen] Intent chooser dialog detected in view hierarchy");
          }
        } catch (intentError) {
          logger.warn(`[ObserveScreen] Failed to detect intent chooser: ${intentError}`);
          // Don't fail the observation if intent chooser detection fails
        }

        if (hierarchy.notificationPermissionDetected !== undefined) {
          result.notificationPermissionDetected = hierarchy.notificationPermissionDetected;
          if (hierarchy.notificationPermissionDetected) {
            logger.debug(
              "[ObserveScreen] Notification permission dialog detected in view hierarchy",
            );
          }
        }
      }

      logger.debug(`View hierarchy retrieval took ${timer.now() - viewHierarchyStart}ms`);
    } catch (error) {
      logger.warn("Failed to get view hierarchy:", error);

      // Clear cache on failure
      try {
        AndroidCtrlProxyManager.getInstance(device, adb).clearAvailabilityCache();
      } catch (clearError) {
        logger.debug(`[HierarchyCollector] Failed to clear availability cache: ${clearError}`);
      }

      const errorStr = String(error);
      if (
        errorStr.includes("null root node returned by UiTestAutomationBridge") ||
        (errorStr.includes("cat:") && errorStr.includes("No such file or directory")) ||
        errorStr.includes("screen appears to be off")
      ) {
        appendObserveError(result, {
          phase: "viewHierarchy",
          message: "Screen appears to be off or device is locked",
          cause: errorStr,
        });
      } else {
        appendObserveError(result, {
          phase: "viewHierarchy",
          message: "Failed to retrieve view hierarchy",
          cause: errorStr,
        });
      }
    }
  }

  /**
   * Fetch raw (unfiltered) view hierarchy and attach it to the result.
   * Invalidates the shared cache after fetching so that the unfiltered snapshot
   * does not bleed into subsequent normal observe calls.
   */
  async collectRaw(result: ObserveResult, signal?: AbortSignal): Promise<void> {
    const { device, adbFactory, timer } = this.opts;
    try {
      if (device.platform === "android") {
        const client = AndroidCtrlProxyClient.getInstance(device, adbFactory);
        const syncResult = await client.requestHierarchySync(
          new NoOpPerformanceTracker(),
          true, // disableAllFiltering
          signal,
        );
        client.invalidateCache();
        if (syncResult?.hierarchy) {
          result.rawViewHierarchy = {
            json: JSON.stringify(syncResult.hierarchy, null, 2),
            source: "accessibility-service",
            timestamp: timer.now(),
            device: { deviceId: device.deviceId, platform: device.platform },
          };
        }
      } else {
        const xcTestClient = IOSCtrlProxyClient.getInstance(device);
        const hierarchyResult = await xcTestClient.requestHierarchySync(
          new NoOpPerformanceTracker(),
          true, // disableAllFiltering
          signal,
        );
        xcTestClient.invalidateCache();
        if (hierarchyResult?.hierarchy) {
          result.rawViewHierarchy = {
            xcuitest: JSON.stringify(hierarchyResult.hierarchy, null, 2),
            source: "xcuitest",
            timestamp: timer.now(),
            device: { deviceId: device.deviceId, platform: device.platform },
          };
        }
      }
    } catch (error) {
      logger.warn("[ObserveScreen] Failed to collect raw view hierarchy:", error);
    }
  }

  /**
   * Extract screen size from view hierarchy root node bounds.
   */
  extractScreenSize(
    viewHierarchy: ObserveResult["viewHierarchy"],
  ): { width: number; height: number } | null {
    const rootNode = viewHierarchy?.hierarchy?.node;
    const rootBounds = parseBounds(rootNode?.bounds ?? rootNode?.$?.bounds);
    if (rootBounds) {
      const width = rootBounds.right - rootBounds.left;
      const height = rootBounds.bottom - rootBounds.top;
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }

    const hierarchyBounds = parseBounds(viewHierarchy?.hierarchy?.bounds);
    if (hierarchyBounds) {
      const width = hierarchyBounds.right - hierarchyBounds.left;
      const height = hierarchyBounds.bottom - hierarchyBounds.top;
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }

    return null;
  }

  /**
   * Reconcile the duplicated `screenWidth`/`screenHeight` fields on the view
   * hierarchy with the authoritative screen size.
   *
   * The iOS CtrlProxy runner reports `UIScreen.main.bounds`, which can be the
   * legacy 320x480 compatibility value when the runner app has no launch screen
   * (see issue #2683). The top-level `screenSize` is derived from the root
   * element bounds and is correct, so we copy it back onto the hierarchy to keep
   * the two values consistent for any consumer that trusts the hierarchy fields.
   *
   * Mutates and returns the same `viewHierarchy` object. When `screenSize` is
   * missing or non-positive the hierarchy is left untouched.
   */
  reconcileScreenDimensions(
    viewHierarchy: ObserveResult["viewHierarchy"],
    screenSize: { width: number; height: number } | null,
  ): ObserveResult["viewHierarchy"] {
    if (!viewHierarchy || typeof viewHierarchy === "string") {
      return viewHierarchy;
    }
    if (!screenSize || screenSize.width <= 0 || screenSize.height <= 0) {
      return viewHierarchy;
    }
    viewHierarchy.screenWidth = screenSize.width;
    viewHierarchy.screenHeight = screenSize.height;
    return viewHierarchy;
  }
}
