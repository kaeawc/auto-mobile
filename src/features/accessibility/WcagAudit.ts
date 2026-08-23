/**
 * WCAG 2.1 accessibility audit implementation
 * Detects common accessibility violations in Android UIs
 */

import crypto from "crypto";
import { Element } from "../../models/Element";
import { ElementBounds } from "../../models/ElementBounds";
import { ViewHierarchyNode } from "../../models/ViewHierarchyResult";
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
    violations.push(...this.checkTouchTargetSizes(elements, config.level));

    // Check for unlabeled form inputs
    violations.push(...this.checkFormInputLabels(elements, viewHierarchy, density));

    // Generate screen ID for baseline tracking
    const screenId = this.generateScreenId(packageName, viewHierarchy);

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
  private checkTouchTargetSizes(elements: Element[], wcagLevel: string): WcagViolation[] {
    const violations: WcagViolation[] = [];

    // WCAG 2.1 Level AA: minimum 44x44 CSS pixels (approx 44 dp on Android)
    // WCAG 2.1 Level AAA: no additional requirement beyond AA
    const minSize = 44;

    for (const element of elements) {
      // Only check clickable elements
      if (!element.clickable) {
        continue;
      }

      const width = element.bounds.right - element.bounds.left;
      const height = element.bounds.bottom - element.bounds.top;

      if (width < minSize || height < minSize) {
        violations.push({
          type: "touch-target-too-small",
          severity: wcagLevel === "AAA" ? "error" : "warning",
          criterion: "2.5.5", // Target Size (Level AAA in WCAG 2.1, AA in WCAG 2.2)
          message: `Touch target is too small: ${width}x${height}dp (minimum: ${minSize}x${minSize}dp)`,
          element,
          details: {
            actualSize: { width, height },
            requiredSize: { width: minSize, height: minSize },
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
  private generateScreenId(packageName: string, hierarchy: ViewHierarchyNode): string {
    // Use package name + root activity/fragment identifier
    // This is a simplified approach - could be enhanced with more specific identifiers
    const rootNode = this.resolveRootNode(hierarchy);
    const rootClass = rootNode.class || "unknown";
    const rootId = rootNode["resource-id"] || "";

    return `${packageName}:${rootClass}:${rootId}`;
  }

  private resolveRootNode(hierarchy: ViewHierarchyNode): ViewHierarchyNode {
    const node = hierarchy.node;
    if (Array.isArray(node) && node.length > 0) {
      return node[node.length - 1] as ViewHierarchyNode;
    }
    if (node && typeof node === "object") {
      return node as ViewHierarchyNode;
    }
    return hierarchy;
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
