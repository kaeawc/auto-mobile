import { logger } from "../../../utils/logger";
import { PerformanceAudit } from "../../performance/PerformanceAudit";
import { ThresholdManager } from "../../performance/ThresholdManager";
import { isPerformanceAuditEnabled } from "../../performance/performanceAuditConfig";
import { DeviceCapabilitiesDetector } from "../../../utils/DeviceCapabilities";
import type {
  BootedDevice,
  ElementBounds,
  ObserveResult,
  ViewHierarchyWindowInfo,
} from "../../../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../../utils/android-cmdline-tools/AdbClientFactory";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";

/**
 * Android's `AccessibilityWindowInfo.TYPE_SYSTEM` constant (status bar,
 * navigation bar, and other SystemUI chrome). The wire `WindowInfo` CtrlProxy
 * actually emits (`android/control-proxy/.../models/WindowInfo.kt`) carries
 * only `id`/`type`/`isActive`/`isFocused`/`bounds` - critically, no
 * per-window `packageName` (see the real fixture,
 * `test/fixtures/observe/android-home.json`, whose `viewHierarchy.windows`
 * has this exact shape). A `type === 3` window is the SystemUI surface;
 * anything else (application, IME, overlay, ...) is a candidate for "the
 * audited app's own window".
 */
const ACCESSIBILITY_WINDOW_TYPE_SYSTEM = 3;

function isCandidateAppWindow(window: ViewHierarchyWindowInfo, appId: string): boolean {
  if (!window.bounds || window.type === ACCESSIBILITY_WINDOW_TYPE_SYSTEM) {
    return false;
  }
  // packageName is never populated by the real Android accessibility window
  // list, but keep the check for forward-compat with a future/other source
  // that does populate it (e.g. a merged uiautomator window list).
  return window.packageName === undefined || window.packageName === appId;
}

/**
 * Find the audited app's own window bounds from the accessibility service's
 * window list, so the touch-latency synthetic tap can be placed inside the
 * app's actual window rather than a fixed screen fraction - correct under
 * split-screen/freeform where the app doesn't occupy the full screen
 * (issue #6167). Prefers the window marked focused; falls back to any
 * non-SystemUI window if none is marked focused. Returns undefined when no
 * matching window bounds are available.
 */
export function findAppWindowBounds(
  result: ObserveResult,
  appId: string,
): ElementBounds | undefined {
  const windows = result.viewHierarchy?.windows;
  if (!windows || windows.length === 0) {
    return undefined;
  }

  const candidates = windows.filter((w) => isCandidateAppWindow(w, appId));
  const focused = candidates.find((w) => w.isFocused);
  return (focused ?? candidates[0])?.bounds;
}

export interface PerformanceAuditorOptions {
  device: BootedDevice;
  /**
   * Factory used to construct dependent components (DeviceCapabilitiesDetector,
   * PerformanceAudit) which require an AdbClientFactory. Defaults to
   * defaultAdbClientFactory. Tests should pass a FakeAdbClientFactory.
   */
  adbFactory?: AdbClientFactory;
  /** Allow tests to stub the config gate */
  isEnabled?: () => boolean;
}

/**
 * Runs the UI performance audit and attaches the result to an ObserveResult.
 *
 * Audit failures are logged but never propagate as errors on the result
 * (the audit is opt-in via config; a failure should not pollute observation).
 */
export class PerformanceAuditor {
  private readonly device: BootedDevice;
  private readonly adbFactory: AdbClientFactory;
  private readonly isEnabled: () => boolean;

  constructor(opts: PerformanceAuditorOptions) {
    this.device = opts.device;
    this.adbFactory = opts.adbFactory ?? defaultAdbClientFactory;
    this.isEnabled = opts.isEnabled ?? isPerformanceAuditEnabled;
  }

  async run(result: ObserveResult, perf: PerformanceTracker): Promise<void> {
    // Check if performance audit is enabled via CLI/config/env gates.
    if (!this.isEnabled()) {
      return;
    }

    // Only run on Android for now
    if (this.device.platform !== "android") {
      logger.debug("[PerformanceAudit] Skipping audit, only Android is supported");
      return;
    }

    // Need an active window with app ID
    if (!result.activeWindow?.appId) {
      logger.debug("[PerformanceAudit] Skipping audit, no active app");
      return;
    }

    try {
      await perf.track("performanceAudit", async () => {
        logger.info(
          `[PerformanceAudit] Running UI performance audit for ${result.activeWindow?.appId}`,
        );

        // Initialize components
        const capabilitiesDetector = new DeviceCapabilitiesDetector(this.device, this.adbFactory);
        const thresholdManager = new ThresholdManager();
        const performanceAudit = new PerformanceAudit(this.device, this.adbFactory);

        // Get device capabilities
        const capabilities = await capabilitiesDetector.getCapabilities();

        // Get or create thresholds
        const thresholds = await thresholdManager.getOrCreateThresholds(
          this.device.deviceId,
          capabilities,
        );

        // Run the audit
        const auditResult = await performanceAudit.runAudit(
          result.activeWindow!.appId,
          thresholds,
          result.screenSize,
          perf,
          findAppWindowBounds(result, result.activeWindow!.appId),
        );

        // Attach audit result to observe result
        result.performanceAudit = auditResult;

        // Update threshold weight based on result
        const sessionId = new Date().toISOString().split("T")[0];
        await thresholdManager.updateThresholdWeight(
          this.device.deviceId,
          sessionId,
          auditResult.passed,
        );

        if (!auditResult.passed) {
          logger.warn(
            `[PerformanceAudit] Performance audit FAILED with ${auditResult.violations.length} violations`,
          );
        } else {
          logger.info("[PerformanceAudit] Performance audit PASSED");
        }

        // Start continuous performance monitoring for this device/package
        const { getPerformanceMonitor } = await import("../../performance/PerformanceMonitor");
        getPerformanceMonitor().startMonitoring(
          this.device.deviceId,
          result.activeWindow!.appId,
          this.device.platform,
        );
      });
    } catch (error) {
      logger.error(`[PerformanceAudit] Failed to run performance audit: ${error}`);
      // Don't fail the entire observation if audit fails
    }
  }
}
