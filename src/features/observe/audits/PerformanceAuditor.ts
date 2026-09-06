import { logger } from "../../../utils/logger";
import { PerformanceAudit } from "../../performance/PerformanceAudit";
import { ThresholdManager } from "../../performance/ThresholdManager";
import { isPerformanceAuditEnabled } from "../../performance/performanceAuditConfig";
import { DeviceCapabilitiesDetector } from "../../../utils/DeviceCapabilities";
import type {
  BootedDevice,
  ElementBounds,
  Element,
  ObserveResult,
  ViewHierarchyWindowInfo,
} from "../../../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../../utils/android-cmdline-tools/AdbClientFactory";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { hasAccessibilityAction, isTruthyFlag } from "../../../utils/elementProperties";
import type { ElementParser } from "../../../utils/interfaces/ElementParser";
import { DefaultElementParser } from "../../utility/ElementParser";

/**
 * `AccessibilityWindowInfo.TYPE_APPLICATION` (Android SDK constant = 1): the
 * only window type that represents genuine app content. The wire `WindowInfo`
 * CtrlProxy actually emits (`android/control-proxy/.../models/WindowInfo.kt`,
 * mapped from `AccessibilityWindowInfo.type` in `ViewHierarchyExtractor.kt`)
 * carries only `id`/`type`/`isActive`/`isFocused`/`bounds` - critically, no
 * per-window `packageName` (see the real fixture,
 * `test/fixtures/observe/android-home.json`, whose `viewHierarchy.windows`
 * has this exact shape).
 *
 * Every other type is chrome, not app content, and must be excluded even
 * when it is the focused window - most importantly `TYPE_INPUT_METHOD` (2):
 * the soft keyboard can hold focus while it's open, and its bounds are not
 * inside the audited app's window. Also excluded by not being
 * TYPE_APPLICATION: `TYPE_SYSTEM` (3, status/nav bar and other SystemUI),
 * `TYPE_ACCESSIBILITY_OVERLAY` (4), `TYPE_SPLIT_SCREEN_DIVIDER` (5), and
 * `TYPE_MAGNIFICATION_OVERLAY` (6).
 */
const ACCESSIBILITY_WINDOW_TYPE_APPLICATION = 1;

function isCandidateAppWindow(window: ViewHierarchyWindowInfo, appId: string): boolean {
  if (!window.bounds || window.type !== ACCESSIBILITY_WINDOW_TYPE_APPLICATION) {
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
 * (issue #6167). Prefers the focused APPLICATION-type window; if no
 * APPLICATION window is focused (e.g. the soft keyboard holds focus instead)
 * falls back to any other APPLICATION window. Returns undefined when no
 * APPLICATION window bounds are available at all - the caller then falls
 * back to a fixed-fraction default point.
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

/**
 * Candidate tap points as fractions of the app window's width/height,
 * ordered by preference: window center first (most representative of "the
 * app"), then the four quadrant centers, then a point near each edge.
 * Deliberately avoids corners closest to a typical top app bar's
 * overflow-menu icon.
 */
const INERT_POINT_CANDIDATE_FRACTIONS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0.5, y: 0.5 }, // center
  { x: 0.25, y: 0.25 },
  { x: 0.75, y: 0.25 },
  { x: 0.25, y: 0.75 },
  { x: 0.75, y: 0.75 },
  { x: 0.5, y: 0.08 }, // near top edge
  { x: 0.5, y: 0.92 }, // near bottom edge
  { x: 0.08, y: 0.5 }, // near left edge
  { x: 0.92, y: 0.5 }, // near right edge
];

/**
 * Least-interactive default when every scanned candidate overlapped an
 * interactive element: near the bottom edge, away from a typical top app
 * bar. Not guaranteed inert (a hierarchy that is a control everywhere has no
 * inert point to offer) - callers must check `inert` on the result rather
 * than treat this point as safe by construction.
 */
const FALLBACK_TOUCH_POINT_FRACTION = { x: 0.5, y: 0.95 };

function isInteractiveElement(element: Element): boolean {
  return (
    isTruthyFlag(element.clickable) ||
    isTruthyFlag(element.focusable) ||
    isTruthyFlag(element["long-clickable"]) ||
    hasAccessibilityAction(element.actions, "click") ||
    hasAccessibilityAction(element.actions, "long_click")
  );
}

function isPointInsideBounds(x: number, y: number, bounds: ElementBounds): boolean {
  return x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom;
}

/**
 * True only for finite bounds with strictly positive width and height.
 * Android can transiently report zero-area or inverted window bounds (e.g.
 * mid-transition, or a window in the process of being torn down) - a naive
 * center calculation on those still produces a defined-looking point (e.g.
 * `{left:100, top:100, right:100, bottom:100}` -> `(100, 100)`), which is
 * not actually inside any real content. Rejecting malformed bounds here,
 * before a point is derived, keeps a transient bad reading from producing a
 * touch point that gets reported inert and tapped (issue #6167 follow-up).
 */
function isValidWindowBounds(bounds: ElementBounds): boolean {
  return (
    Number.isFinite(bounds.left) &&
    Number.isFinite(bounds.top) &&
    Number.isFinite(bounds.right) &&
    Number.isFinite(bounds.bottom) &&
    bounds.right - bounds.left > 0 &&
    bounds.bottom - bounds.top > 0
  );
}

export interface InertTouchPointResult {
  point: { x: number; y: number };
  /**
   * False when no scanned candidate avoided every interactive element - the
   * returned point is the documented fallback default, not a verified-inert
   * one (issue #6167).
   */
  inert: boolean;
}

/**
 * Find a synthetic-touch point inside `windowBounds` that does not overlap
 * any clickable/focusable/long-clickable element, so a touch-latency probe
 * cannot activate a real control (tap a button, open a list item, follow a
 * link) during what is meant to be a read-only performance audit
 * (issue #6167). Scans a small set of candidate points (window center, then
 * quadrant centers, then edge midpoints) and returns the first that hits no
 * interactive element's bounds. Falls back to a documented default point
 * when every candidate is obstructed, with `inert: false` so the caller
 * knows the tap may still land on a control.
 */
export function findInertTouchPoint(
  windowBounds: ElementBounds,
  interactiveElements: readonly Element[],
): InertTouchPointResult {
  const obstacles = interactiveElements.filter((el) => el.bounds && isInteractiveElement(el));
  const width = windowBounds.right - windowBounds.left;
  const height = windowBounds.bottom - windowBounds.top;

  const pointFor = (fraction: { x: number; y: number }): { x: number; y: number } => ({
    x: Math.floor(windowBounds.left + width * fraction.x),
    y: Math.floor(windowBounds.top + height * fraction.y),
  });

  for (const fraction of INERT_POINT_CANDIDATE_FRACTIONS) {
    const point = pointFor(fraction);
    const obstructed = obstacles.some((el) => isPointInsideBounds(point.x, point.y, el.bounds));
    if (!obstructed) {
      return { point, inert: true };
    }
  }

  logger.warn(
    "[PerformanceAudit] Could not find a fully inert touch point inside the app window " +
      "(every scanned candidate overlapped an interactive element) - falling back to a " +
      "default point that may still activate a control",
  );
  return { point: pointFor(FALLBACK_TOUCH_POINT_FRACTION), inert: false };
}

/**
 * Collect every hierarchy element that could be an obstacle for
 * `findInertTouchPoint` - i.e. everything `isInteractiveElement` would flag,
 * across the main hierarchy and any secondary windows (dialogs, sheets).
 *
 * Deliberately NOT `result.elements.clickable`: `DefaultObserveElementCollector`
 * populates that list only for `clickable`/`click`-action nodes, but
 * `isInteractiveElement` (and therefore the inert-point scan) also treats
 * `focusable`, `long-clickable`, and `long_click` nodes as obstacles. A
 * focusable-only or long-clickable-only control covering a candidate point
 * would otherwise never be supplied as an obstacle, and the scan could land
 * on (and activate/focus) it (issue #6167 follow-up). Walking the raw
 * hierarchy with the same `isInteractiveElement` predicate the scan itself
 * applies keeps the two from drifting apart.
 */
export function collectInteractiveObstacles(
  result: ObserveResult,
  elementParser: ElementParser = new DefaultElementParser(),
): Element[] {
  if (!result.viewHierarchy) {
    return result.elements?.clickable ?? [];
  }
  return elementParser
    .flattenViewHierarchy(result.viewHierarchy, { includeWindows: true })
    .map((entry) => entry.element);
}

export interface TouchLatencyPointDecision {
  /** A verified-inert coordinate to tap, present only when one was found. */
  touchPoint?: { x: number; y: number };
  /**
   * True when there is no verified-inert point to tap - either `windowBounds`
   * was undefined (no app window found), or every scanned candidate
   * overlapped an interactive element. The caller must skip the
   * touch-latency measurement entirely in this case rather than fall
   * through to `TouchLatencyTracker`'s own unverified default point, which
   * risks activating a full-screen button, WebView, or map (issue #6167).
   */
  skipTouchLatency: boolean;
}

/**
 * Derive the synthetic touch-latency tap point exactly as
 * `PerformanceAuditor.run` does, so tests can exercise this decision through
 * the real production obstacle-collection path rather than hand-building an
 * obstacle list for `findInertTouchPoint` directly.
 */
export function deriveTouchLatencyPoint(
  windowBounds: ElementBounds | undefined,
  result: ObserveResult,
  elementParser: ElementParser = new DefaultElementParser(),
): TouchLatencyPointDecision {
  if (!windowBounds) {
    return { skipTouchLatency: true };
  }

  if (!isValidWindowBounds(windowBounds)) {
    logger.warn(
      "[PerformanceAudit] Skipping touch-latency measurement: window bounds are malformed " +
        `(zero-area, inverted, or non-finite): ${JSON.stringify(windowBounds)}`,
    );
    return { skipTouchLatency: true };
  }

  const obstacles = collectInteractiveObstacles(result, elementParser);
  const { point, inert } = findInertTouchPoint(windowBounds, obstacles);
  if (!inert) {
    return { skipTouchLatency: true };
  }
  return { touchPoint: point, skipTouchLatency: false };
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

        // Derive a touch point inside the app's own window that avoids
        // activating a real control - a read-only performance audit must
        // not tap a button, list item, or link as a side effect (#6167).
        const windowBounds = findAppWindowBounds(result, result.activeWindow!.appId);
        const { touchPoint, skipTouchLatency } = deriveTouchLatencyPoint(windowBounds, result);

        // Run the audit
        const auditResult = await performanceAudit.runAudit(
          result.activeWindow!.appId,
          thresholds,
          result.screenSize,
          perf,
          windowBounds,
          touchPoint,
          skipTouchLatency,
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
