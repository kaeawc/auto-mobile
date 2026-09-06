/**
 * WCAG 2.1 accessibility audit implementation
 * Detects common accessibility violations in Android UIs
 */

import crypto from "crypto";
import { Element } from "../../models/Element";
import { ElementBounds } from "../../models/ElementBounds";
import { ViewHierarchyNode, ViewHierarchyWindowInfo } from "../../models/ViewHierarchyResult";
import {
  AccessibilityAuditConfig,
  AccessibilityAuditResult,
  WcagViolation,
  ViolationType,
  AccessibilityAuditSummary,
} from "../../models/AccessibilityAudit";
import { ContrastChecker } from "./ContrastChecker";
import { BaselineManager } from "./BaselineManager";
import { Timer, defaultTimer } from "../../utils/SystemTimer";

export interface WcagBaselineStore {
  getBaseline(
    screenId: string,
  ): Promise<{ violations: Pick<WcagViolation, "fingerprint">[] } | null>;
  saveBaseline(screenId: string, violations: WcagViolation[]): Promise<void>;
  clearBaseline(screenId: string): Promise<void>;
}

export class WcagAudit {
  private contrastChecker: ContrastChecker;
  private baselineStore: WcagBaselineStore;
  private timer: Timer;

  constructor(
    timer: Timer = defaultTimer,
    baselineStore: WcagBaselineStore = new BaselineManager(),
  ) {
    this.contrastChecker = new ContrastChecker({}, timer);
    this.baselineStore = baselineStore;
    this.timer = timer;
  }

  /**
   * Perform a WCAG accessibility audit on the current screen
   */
  async audit(
    elements: Element[],
    viewHierarchy: ViewHierarchyNode,
    screenshotPath: string | undefined,
    packageName: string,
    config: AccessibilityAuditConfig,
    density?: number,
    windows?: ViewHierarchyWindowInfo[],
  ): Promise<AccessibilityAuditResult> {
    const violations: WcagViolation[] = [];

    // Check for missing content descriptions
    violations.push(...this.checkMissingContentDescriptions(elements));

    // Check for insufficient contrast ratios (if screenshot available)
    if (screenshotPath) {
      const contrastViolations = await this.checkContrastRatios(
        elements,
        screenshotPath,
        config.level,
        config.contrast,
      );
      violations.push(...contrastViolations);
    }

    // Check for touch target size violations
    violations.push(...this.checkTouchTargetSizes(elements, config.level, density));

    // Check for unlabeled form inputs
    violations.push(...this.checkFormInputLabels(elements, viewHierarchy, density));

    // Generate screen ID for baseline tracking
    const screenId = this.generateScreenId(packageName, viewHierarchy, windows);

    // Filter violations based on baseline if enabled
    let filteredViolations = violations;
    let baselinedCount = 0;

    if (config.useBaseline) {
      const baseline = await this.baselineStore.getBaseline(screenId);
      if (baseline) {
        const baselineFingerprints = new Set(baseline.violations.map((v) => v.fingerprint));
        filteredViolations = violations.filter((v) => !baselineFingerprints.has(v.fingerprint));
        baselinedCount = violations.length - filteredViolations.length;
      }
    }

    // Generate summary
    const summary = this.generateSummary(violations, filteredViolations, baselinedCount, config);

    return {
      config,
      summary,
      violations: filteredViolations,
      timestamp: this.timer.now(),
      screenId,
    };
  }

  /**
   * Save current violations as baseline
   */
  async saveBaseline(result: AccessibilityAuditResult): Promise<void> {
    await this.baselineStore.saveBaseline(result.screenId, result.violations);
  }

  /**
   * Clear baseline for a screen
   */
  async clearBaseline(screenId: string): Promise<void> {
    await this.baselineStore.clearBaseline(screenId);
  }

  /**
   * Check for clickable/focusable elements without content descriptions
   */
  private checkMissingContentDescriptions(elements: Element[]): WcagViolation[] {
    const violations: WcagViolation[] = [];

    for (const element of elements) {
      // Skip if element has text or content-desc
      if (element.text || element["content-desc"]) {
        continue;
      }

      // Check if element is interactive
      const isInteractive = element.clickable || element.focusable || element.checkable;

      if (isInteractive) {
        violations.push({
          type: "missing-content-description",
          severity: "error",
          criterion: "1.1.1", // Non-text Content
          message: `Interactive element (${element.class || "unknown"}) lacks accessible label`,
          element,
          details: {
            explanation:
              "Clickable, focusable, or checkable elements must have a text label or content-desc for screen readers",
          },
          fingerprint: this.generateFingerprint(element, "missing-content-description"),
        });
      }
    }

    return violations;
  }

  /**
   * Check text contrast ratios against WCAG standards
   * Optimized to use batch processing for better performance
   */
  private async checkContrastRatios(
    elements: Element[],
    screenshotPath: string,
    wcagLevel: string,
    contrastConfig?: AccessibilityAuditConfig["contrast"],
  ): Promise<WcagViolation[]> {
    const violations: WcagViolation[] = [];

    // Filter to text elements only
    const textElements = elements.filter((e) => e.text && e.text.trim().length > 0);

    // Use batch processing for optimal performance
    const checker = contrastConfig
      ? new ContrastChecker(contrastConfig, this.timer)
      : this.contrastChecker;
    const results = await checker.checkContrastBatch(
      screenshotPath,
      textElements,
      wcagLevel as "A" | "AA" | "AAA",
    );

    // Process results and create violations
    for (const [element, result] of results.entries()) {
      if (result && result.minRatio < result.requiredRatio) {
        const ratioText = result.minRatio.toFixed(2);
        const maxText = result.maxRatio.toFixed(2);
        const avgText = result.avgRatio.toFixed(2);
        const shadowNote = result.shadowDetected ? " (shadow-enhanced)" : "";
        violations.push({
          type: "insufficient-contrast",
          severity: wcagLevel === "AAA" ? "warning" : "error",
          criterion: "1.4.3", // Contrast (Minimum) for AA, 1.4.6 for AAA
          message: `Text has insufficient contrast ratio: ${ratioText}:1 (required: ${result.requiredRatio}:1)`,
          element,
          details: {
            contrastRatio: parseFloat(ratioText),
            contrastMinRatio: parseFloat(ratioText),
            contrastMaxRatio: parseFloat(maxText),
            contrastAvgRatio: parseFloat(avgText),
            requiredRatio: result.requiredRatio,
            explanation: `Text color RGB(${result.textColor.r},${result.textColor.g},${result.textColor.b}) on background RGB(${result.backgroundColor.r},${result.backgroundColor.g},${result.backgroundColor.b}). Samples min/avg/max=${ratioText}/${avgText}/${maxText}${shadowNote}.`,
          },
          fingerprint: this.generateFingerprint(element, "insufficient-contrast"),
        });
      }
    }

    return violations;
  }

  /**
   * Check for touch targets that are too small
   */
  private checkTouchTargetSizes(
    elements: Element[],
    wcagLevel: string,
    density?: number,
  ): WcagViolation[] {
    const violations: WcagViolation[] = [];

    // WCAG 2.1 Level AA: minimum 44x44 dp on Android.
    // WCAG 2.1 Level AAA: no additional requirement beyond AA.
    const minSizeDp = 44;

    // `bounds` are physical pixels (see Element.ts / ViewHierarchyNode), so the
    // dp gate must be scaled by density the same way checkFormInputLabels
    // scales its gap gate (labelGapThresholdPx) — otherwise a 33dp target on an
    // xxhdpi device (~100px) is compared against a raw 44px and wrongly passes.
    const dpi = density && density > 0 ? density : WcagAudit.FALLBACK_DENSITY_DPI;
    const minSizePx = minSizeDp * (dpi / WcagAudit.BASELINE_DENSITY_DPI);

    for (const element of elements) {
      // Only check clickable elements
      if (!element.clickable) {
        continue;
      }

      const widthPx = element.bounds.right - element.bounds.left;
      const heightPx = element.bounds.bottom - element.bounds.top;

      if (widthPx < minSizePx || heightPx < minSizePx) {
        // Report the measured size in dp, not raw px, so the message is
        // labeled correctly regardless of device density. Round DOWN rather
        // than to nearest: a violation's exact dp size is always < minSizeDp
        // (that's why it violated), and rounding to nearest can carry a
        // fractional dp (e.g. 43.81dp) up to display as the minimum itself
        // (44dp), which reads as passing next to "minimum: 44x44dp".
        const widthDp = Math.floor((widthPx * WcagAudit.BASELINE_DENSITY_DPI) / dpi);
        const heightDp = Math.floor((heightPx * WcagAudit.BASELINE_DENSITY_DPI) / dpi);

        violations.push({
          type: "touch-target-too-small",
          severity: wcagLevel === "AAA" ? "error" : "warning",
          criterion: "2.5.5", // Target Size (Level AAA in WCAG 2.1, AA in WCAG 2.2)
          message: `Touch target is too small: ${widthDp}x${heightDp}dp (minimum: ${minSizeDp}x${minSizeDp}dp)`,
          element,
          details: {
            actualSize: { width: widthDp, height: heightDp },
            requiredSize: { width: minSizeDp, height: minSizeDp },
            explanation: "Touch targets should be at least 44x44 dp to be easily tappable",
          },
          fingerprint: this.generateFingerprint(element, "touch-target-too-small"),
        });
      }
    }

    return violations;
  }

  /**
   * Check for form inputs without associated labels
   */
  private checkFormInputLabels(
    elements: Element[],
    hierarchy: ViewHierarchyNode,
    density?: number,
  ): WcagViolation[] {
    const violations: WcagViolation[] = [];

    // Identify form input elements
    const inputElements = elements.filter(
      (e) =>
        e.class?.includes("EditText") ||
        e.class?.includes("Spinner") ||
        e.class?.includes("CheckBox") ||
        e.class?.includes("RadioButton"),
    );

    // Compute the candidate label TextViews once, not once per input
    // (hasNearbyLabel was O(inputs * elements) just rebuilding this list).
    const textViews = elements.filter((e) => e.class?.includes("TextView") && e.text);

    // Scale the proximity gate for this device's pixel density once per audit.
    const gapThresholdPx = this.labelGapThresholdPx(density);

    for (const input of inputElements) {
      // Check if input has a label via text, content-desc, or nearby TextView
      const hasLabel =
        input.text ||
        input["content-desc"] ||
        this.hasNearbyLabel(input, textViews, gapThresholdPx);

      if (!hasLabel) {
        violations.push({
          type: "unlabeled-form-input",
          severity: "error",
          criterion: "3.3.2", // Labels or Instructions
          message: `Form input (${input.class || "unknown"}) lacks accessible label`,
          element: input,
          details: {
            explanation:
              "Form inputs must have associated labels for screen reader users to understand their purpose",
          },
          fingerprint: this.generateFingerprint(input, "unlabeled-form-input"),
        });
      }
    }

    return violations;
  }

  /**
   * Maximum gap between a form input and a candidate label TextView, expressed
   * in density-independent pixels (dp), for the TextView to be treated as that
   * input's visible label. Form labels sit immediately above or beside their
   * input, so the bounding boxes are adjacent (a small gap), not merely on the
   * same row.
   */
  private static readonly LABEL_GAP_DP = 50;

  /** Android baseline density (mdpi): 1dp == 1px at 160 DPI. */
  private static readonly BASELINE_DENSITY_DPI = 160;

  /**
   * Fallback density (≈xhdpi / 2x) used when the hierarchy did not report one —
   * older runners omit it. Chosen from the mid-to-high end of the modern device
   * fleet so a real, normally-spaced label is not mistaken for "no label" (a
   * false positive) on the common case; when density IS reported it is used
   * directly and this value is irrelevant.
   */
  private static readonly FALLBACK_DENSITY_DPI = 320;

  /**
   * Resolve the label-proximity gate in physical pixels for this device.
   *
   * `bounds` are physical pixels on Android (see Element.ts / ViewHierarchyNode),
   * so a fixed pixel gate is density-dependent: 50px is ~50dp on an mdpi device
   * but only ~17dp on a 3x (480 DPI) phone, wrongly rejecting normally-spaced
   * labels there. Scaling `LABEL_GAP_DP` by `density / 160` keeps the gate a
   * constant physical/visual distance across densities.
   */
  private labelGapThresholdPx(density?: number): number {
    const dpi = density && density > 0 ? density : WcagAudit.FALLBACK_DENSITY_DPI;
    return WcagAudit.LABEL_GAP_DP * (dpi / WcagAudit.BASELINE_DENSITY_DPI);
  }

  /**
   * Check if an element has a nearby TextView that could serve as a label.
   * `textViews` is precomputed by the caller (see checkFormInputLabels) so this
   * is O(textViews) per input rather than re-filtering all elements each call.
   * `gapThresholdPx` is the density-scaled gate from `labelGapThresholdPx`.
   *
   * Proximity is the Euclidean gap between the input's and the TextView's
   * bounding boxes, and only the NEAREST candidate is compared to the gate. This
   * replaces a prior `||`-of-per-axis-center-distance test that treated any
   * TextView sharing the input's horizontal OR vertical band — even one on the
   * opposite edge of the screen — as a label, under-reporting unlabeled inputs.
   */
  private hasNearbyLabel(input: Element, textViews: Element[], gapThresholdPx: number): boolean {
    let nearestGap = Infinity;

    for (const textView of textViews) {
      const gap = this.boundingBoxGap(input.bounds, textView.bounds);
      if (gap < nearestGap) {
        nearestGap = gap;
      }
    }

    return nearestGap <= gapThresholdPx;
  }

  /**
   * Euclidean distance between the nearest edges of two axis-aligned rectangles.
   * Returns 0 when the rectangles overlap or touch. Unlike center-to-center
   * distance this stays small for a label sitting directly above or beside an
   * input even when the label is wide — the real-world layout for form labels.
   */
  private boundingBoxGap(a: ElementBounds, b: ElementBounds): number {
    const dx = Math.max(0, a.left - b.right, b.left - a.right);
    const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Generate a unique fingerprint for a violation
   */
  private generateFingerprint(element: Element, violationType: ViolationType): string {
    const data = JSON.stringify({
      type: violationType,
      resourceId: element["resource-id"],
      class: element.class,
      bounds: element.bounds,
      text: element.text,
    });

    return crypto.createHash("md5").update(data).digest("hex");
  }

  /**
   * Generate screen identifier for baseline tracking
   */
  private generateScreenId(
    packageName: string,
    hierarchy: ViewHierarchyNode,
    windows?: ViewHierarchyWindowInfo[],
  ): string {
    // Use package name + root activity/fragment identifier
    // This is a simplified approach - could be enhanced with more specific identifiers
    //
    // Node attributes (class, resource-id) live in one of TWO shapes depending on
    // the hierarchy's source (issue #6252): xml2js-parsed uiautomator dumps nest
    // them under `$` (`node.$.class`), while CtrlProxy's accessibility-service
    // conversion (`CtrlProxyHierarchy.convertAccessibilityNode`) writes `class`/
    // `resource-id` directly on the node and never creates `$`. Reading only one
    // shape leaves the other always undefined, collapsing every screen on that
    // source to the same "unknown:" id and defeating per-screen baseline
    // tracking. `getNodeClass`/`getNodeResourceId` check both.
    const activeRoot = this.resolveRootNode(hierarchy, windows);
    const rootNode = this.descendToMeaningfulNode(activeRoot);
    const rootClass = this.getNodeClass(rootNode) || "unknown";
    const rootId = this.getNodeResourceId(rootNode) || "";

    return `${packageName}:${rootClass}:${rootId}`;
  }

  /**
   * A `ViewHierarchyNode` as actually produced by the CtrlProxy accessibility
   * conversion path, which writes `class`/`resource-id` as flat properties
   * instead of nesting them under `$` (see `generateScreenId`). Declared as an
   * intersection (additional optional properties), not a cast to an unrelated
   * type, so it does not trip TS2352 the way `as ViewHierarchyNode` would.
   */
  private asFlatAttrNode(
    node: ViewHierarchyNode,
  ): ViewHierarchyNode & { class?: unknown; className?: unknown; "resource-id"?: unknown } {
    return node as ViewHierarchyNode & {
      class?: unknown;
      className?: unknown;
      "resource-id"?: unknown;
    };
  }

  /**
   * Read `class` from either node-attribute shape (see `generateScreenId`).
   * `className` (issue #6274) is the field name CtrlProxy's accessibility
   * hierarchy actually writes (see test/fixtures/observe/android-home.json) —
   * neither `$.class` nor flat `class` is ever populated on it, so without
   * this fallback every production Android node reads as classless.
   */
  private getNodeClass(node: ViewHierarchyNode): string | undefined {
    const flat = this.asFlatAttrNode(node);
    const value = flat.$?.class ?? flat.class ?? flat.className;
    return typeof value === "string" ? value : undefined;
  }

  /** Read `resource-id` from either node-attribute shape (see `generateScreenId`). */
  private getNodeResourceId(node: ViewHierarchyNode): string | undefined {
    const flat = this.asFlatAttrNode(node);
    const value = flat.$?.["resource-id"] ?? flat["resource-id"];
    return typeof value === "string" ? value : undefined;
  }

  /**
   * Descend through attribute-less pass-through wrappers (window decor, content
   * frame) to the first descendant that actually carries a class or
   * resource-id, so the baseline id reflects real screen content instead of
   * generic window chrome. Stops at a branch point (multiple children) or a
   * leaf so it never silently jumps to an unrelated subtree.
   */
  private descendToMeaningfulNode(
    node: ViewHierarchyNode,
    maxDepth: number = 10,
  ): ViewHierarchyNode {
    let current = node;
    for (let depth = 0; depth < maxDepth; depth++) {
      if (this.getNodeClass(current) || this.getNodeResourceId(current)) {
        return current;
      }
      const child = current.node;
      // A single-object child (not wrapped in an array) is the common
      // pass-through shape for CtrlProxy's accessibility hierarchy despite the
      // `ViewHierarchyNode[]` static type (see `resolveRootNode`'s identical
      // runtime-shape handling above). An array child is a branch point —
      // stop rather than guess which sibling to follow.
      if (child && typeof child === "object" && !Array.isArray(child)) {
        current = child as ViewHierarchyNode;
        continue;
      }
      return current;
    }
    return current;
  }

  /** `AccessibilityWindowInfo.TYPE_SYSTEM` — the window type CtrlProxy reports for SystemUI. */
  private static readonly ACCESSIBILITY_WINDOW_TYPE_SYSTEM = 3;
  private static readonly SYSTEM_UI_PACKAGE = "com.android.systemui";

  /** Same window/package signal `ObserveScreen` uses to distinguish app vs SystemUI windows. */
  private isSystemUiWindow(window: ViewHierarchyWindowInfo): boolean {
    return (
      window.packageName === WcagAudit.SYSTEM_UI_PACKAGE ||
      window.type === WcagAudit.ACCESSIBILITY_WINDOW_TYPE_SYSTEM
    );
  }

  private boundsEqual(a: ElementBounds | undefined, b: ElementBounds | undefined): boolean {
    if (!a || !b) {
      return false;
    }
    return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
  }

  private boundsArea(bounds: ElementBounds | undefined): number {
    if (!bounds) {
      return 0;
    }
    return Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top);
  }

  /**
   * Pick the root node baseline tracking should key off. A production-shaped
   * hierarchy carries one root PER WINDOW (issue #6274 — see
   * test/fixtures/observe/android-home.json and
   * test/fixtures/observe/diff/scroll-before.json), so blindly taking the last
   * entry lands on the attribute-less SystemUI status-bar wrapper, generating
   * an `<appId>:unknown:` baseline id that lets one screen's baseline suppress
   * another screen's violations.
   *
   * Prefer the ACTIVE APP window root: the focused (falling back to active),
   * non-SystemUI window from the accessibility `windows[]` metadata — the same
   * signal `ObserveScreen`'s `classifyFocusedSystemUiWindow` uses to
   * distinguish app vs SystemUI windows — matched to its root node by bounds.
   * When no `windows[]` metadata is available, fall back to the largest root by
   * bounds area: the SystemUI status/navigation bar is always a thin sliver
   * next to the full-screen app content root.
   */
  private resolveRootNode(
    hierarchy: ViewHierarchyNode,
    windows?: ViewHierarchyWindowInfo[],
  ): ViewHierarchyNode {
    const node = hierarchy.node;
    if (!Array.isArray(node)) {
      if (node && typeof node === "object") {
        return node as ViewHierarchyNode;
      }
      return hierarchy;
    }
    if (node.length === 0) {
      return hierarchy;
    }
    if (node.length === 1) {
      return node[0] as ViewHierarchyNode;
    }

    if (windows && windows.length > 0) {
      const activeWindow =
        windows.find((w) => w.isFocused === true && !this.isSystemUiWindow(w)) ??
        windows.find((w) => w.isActive === true && !this.isSystemUiWindow(w));
      if (activeWindow?.bounds) {
        const matched = node.find((candidate) =>
          this.boundsEqual((candidate as ViewHierarchyNode).bounds, activeWindow.bounds),
        );
        if (matched) {
          return matched as ViewHierarchyNode;
        }
      }
    }

    return (node as ViewHierarchyNode[]).reduce((largest, candidate) =>
      this.boundsArea(candidate.bounds) > this.boundsArea(largest.bounds) ? candidate : largest,
    );
  }

  /**
   * Generate summary statistics
   */
  private generateSummary(
    allViolations: WcagViolation[],
    filteredViolations: WcagViolation[],
    baselinedCount: number,
    config: AccessibilityAuditConfig,
  ): AccessibilityAuditSummary {
    const bySeverity = {
      error: filteredViolations.filter((v) => v.severity === "error").length,
      warning: filteredViolations.filter((v) => v.severity === "warning").length,
      info: filteredViolations.filter((v) => v.severity === "info").length,
    };

    const byType: Record<ViolationType, number> = {
      "missing-content-description": 0,
      "insufficient-contrast": 0,
      "touch-target-too-small": 0,
      "unlabeled-form-input": 0,
    };

    for (const violation of filteredViolations) {
      byType[violation.type]++;
    }

    // Determine if audit passed based on failure mode
    let passed = true;
    let failureReason: string | undefined;

    if (config.failureMode === "strict" && filteredViolations.length > 0) {
      passed = false;
      failureReason = `Found ${filteredViolations.length} accessibility violation(s) in strict mode`;
    } else if (config.failureMode === "threshold") {
      const minSeverity = config.minSeverity || "warning";
      const relevantViolations = filteredViolations.filter((v) => {
        if (minSeverity === "error") {
          return v.severity === "error";
        }
        if (minSeverity === "warning") {
          return v.severity === "error" || v.severity === "warning";
        }
        return true;
      });

      if (relevantViolations.length > 0) {
        passed = false;
        failureReason = `Found ${relevantViolations.length} violation(s) at or above ${minSeverity} severity`;
      }
    }
    // "report" mode always passes

    return {
      totalViolations: allViolations.length,
      bySeverity,
      byType,
      baselinedViolations: baselinedCount,
      passed,
      failureReason,
    };
  }
}
