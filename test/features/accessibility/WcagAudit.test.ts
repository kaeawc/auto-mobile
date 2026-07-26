/**
 * Unit tests for WcagAudit
 * Tests WCAG violation detection and audit functionality
 */

import { expect, describe, it, beforeEach } from "bun:test";
import { WcagAudit } from "../../../src/features/accessibility/WcagAudit";
import { BaselineManager } from "../../../src/features/accessibility/BaselineManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { Element } from "../../../src/models/Element";
import type { ViewHierarchyNode } from "../../../src/models/ViewHierarchyResult";
import type { AccessibilityAuditConfig } from "../../../src/models/AccessibilityAudit";

/**
 * BaselineManager double that returns a canned baseline without touching any
 * database. Construction alone never resolves the file-backed singleton (the DB
 * handle is resolved lazily), and getBaseline is overridden so the query path is
 * never reached (issue #3067).
 */
class StubBaselineManager extends BaselineManager {
  constructor(private readonly stub: Awaited<ReturnType<BaselineManager["getBaseline"]>>) {
    super();
  }
  async getBaseline(): Promise<Awaited<ReturnType<BaselineManager["getBaseline"]>>> {
    return this.stub;
  }
}

describe("WcagAudit", function() {
  let audit: WcagAudit;

  beforeEach(function() {
    audit = new WcagAudit();
  });

  describe("Missing Content Descriptions", function() {
    it("should detect clickable elements without text or content-desc", async function() {
      const elements: Element[] = [
        {
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          clickable: true,
          // No text or content-desc
        },
      ];

      const hierarchy: ViewHierarchyNode = { class: "View", children: [] };
      const config: AccessibilityAuditConfig = {
        level: "AA",
        failureMode: "report",
        useBaseline: false,
      };

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config);

      const contentDescViolations = result.violations.filter(
        v => v.type === "missing-content-description"
      );
      expect(contentDescViolations).toHaveLength(1);
    });

    it("should NOT flag elements with text", async function() {
      const elements: Element[] = [
        {
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          clickable: true,
          text: "Click me",
        },
      ];

      const hierarchy: ViewHierarchyNode = { class: "View", children: [] };
      const config: AccessibilityAuditConfig = {
        level: "AA",
        failureMode: "report",
        useBaseline: false,
      };

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config);

      const contentDescViolations = result.violations.filter(
        v => v.type === "missing-content-description"
      );
      expect(contentDescViolations).toHaveLength(0);
    });

    it("should NOT flag elements with content-desc", async function() {
      const elements: Element[] = [
        {
          "bounds": { left: 0, top: 0, right: 100, bottom: 50 },
          "clickable": true,
          "content-desc": "Clickable button",
        },
      ];

      const hierarchy: ViewHierarchyNode = { class: "View", children: [] };
      const config: AccessibilityAuditConfig = {
        level: "AA",
        failureMode: "report",
        useBaseline: false,
      };

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config);

      const contentDescViolations = result.violations.filter(
        v => v.type === "missing-content-description"
      );
      expect(contentDescViolations).toHaveLength(0);
    });

    it("should NOT flag non-interactive elements without labels", async function() {
      const elements: Element[] = [
        {
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          clickable: false,
          focusable: false,
        },
      ];

      const hierarchy: ViewHierarchyNode = { class: "View", children: [] };
      const config: AccessibilityAuditConfig = {
        level: "AA",
        failureMode: "report",
        useBaseline: false,
      };

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config);

      const contentDescViolations = result.violations.filter(
        v => v.type === "missing-content-description"
      );
      expect(contentDescViolations).toHaveLength(0);
    });

    it("should handle elements with only whitespace text", async function() {
      const elements: Element[] = [
        {
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          clickable: true,
          text: "   ",
        },
      ];

      const hierarchy: ViewHierarchyNode = { class: "View", children: [] };
      const config: AccessibilityAuditConfig = {
        level: "AA",
        failureMode: "report",
        useBaseline: false,
      };

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config);

      const contentDescViolations = result.violations.filter(
        v => v.type === "missing-content-description"
      );
      // Current implementation treats whitespace as valid text (doesn't trim)
      expect(contentDescViolations).toHaveLength(0);
    });
  });

  describe("Touch Target Size", function() {
    it("should detect targets smaller than 44x44dp", async function() {
      const elements: Element[] = [
        {
          bounds: { left: 0, top: 0, right: 40, bottom: 40 }, // 40x40 < 44x44
          clickable: true,
          text: "Small",
        },
      ];

      const hierarchy: ViewHierarchyNode = { class: "View", children: [] };
      const config: AccessibilityAuditConfig = {
        level: "AA",
        failureMode: "report",
        useBaseline: false,
      };

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config);

      const sizeViolations = result.violations.filter(v => v.type === "touch-target-too-small");
      expect(sizeViolations).toHaveLength(1);
    });

    it("should pass targets at exactly 44x44dp", async function() {
      const elements: Element[] = [
        {
          bounds: { left: 0, top: 0, right: 44, bottom: 44 }, // Exactly 44x44
          clickable: true,
          text: "Perfect",
        },
      ];

      const hierarchy: ViewHierarchyNode = { class: "View", children: [] };
      const config: AccessibilityAuditConfig = {
        level: "AA",
        failureMode: "report",
        useBaseline: false,
      };

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config);

      const sizeViolations = result.violations.filter(v => v.type === "touch-target-too-small");
      expect(sizeViolations).toHaveLength(0);
    });

    it("should pass targets larger than 44x44dp", async function() {
      const elements: Element[] = [
        {
          bounds: { left: 0, top: 0, right: 100, bottom: 50 }, // Larger
          clickable: true,
          text: "Large",
        },
      ];

      const hierarchy: ViewHierarchyNode = { class: "View", children: [] };
      const config: AccessibilityAuditConfig = {
        level: "AA",
        failureMode: "report",
        useBaseline: false,
      };

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config);

      const sizeViolations = result.violations.filter(v => v.type === "touch-target-too-small");
      expect(sizeViolations).toHaveLength(0);
    });

    it("should only check clickable elements", async function() {
      const elements: Element[] = [
        {
          bounds: { left: 0, top: 0, right: 20, bottom: 20 }, // Small but not clickable
          clickable: false,
          text: "Not clickable",
        },
      ];

      const hierarchy: ViewHierarchyNode = { class: "View", children: [] };
      const config: AccessibilityAuditConfig = {
        level: "AA",
        failureMode: "report",
        useBaseline: false,
      };

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config);

      const sizeViolations = result.violations.filter(v => v.type === "touch-target-too-small");
      expect(sizeViolations).toHaveLength(0);
    });
  });

  describe("Summary Generation", function() {
    it("should generate correct summary statistics", async function() {
      const elements: Element[] = [
        {
          bounds: { left: 0, top: 0, right: 20, bottom: 20 },
          clickable: true,
          // Missing content-desc
        },
        {
          bounds: { left: 0, top: 30, right: 30, bottom: 60 },
          clickable: true,
          // Missing content-desc and too small
        },
      ];

      const hierarchy: ViewHierarchyNode = { class: "View", children: [] };
      const config: AccessibilityAuditConfig = {
        level: "AA",
        failureMode: "strict", // Use strict mode to fail on any violations
        useBaseline: false,
      };

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config);

      // The fixture is two clickable, unlabelled elements both under 44x44dp, so
      // each yields a missing-content-description (error) AND a
      // touch-target-too-small (warning): exactly 4 violations.
      expect(result.summary.totalViolations).toBe(4);
      expect(result.summary.bySeverity).toEqual({ error: 2, warning: 2, info: 0 });
      expect(result.summary.byType["missing-content-description"]).toBe(2);
      expect(result.summary.byType["touch-target-too-small"]).toBe(2);
      expect(result.summary.passed).toBe(false);
    });

    it("should handle missing screenshot gracefully", async function() {
      const elements: Element[] = [
        {
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          text: "Test",
        },
      ];

      const hierarchy: ViewHierarchyNode = { class: "View", children: [] };
      const config: AccessibilityAuditConfig = {
        level: "AA",
        failureMode: "report",
        useBaseline: false,
      };

      // No screenshot provided - should not throw
      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config);

      expect(result).not.toBeNull();
      expect(result.violations).toBeInstanceOf(Array);
      // Should not have contrast violations without screenshot
      const contrastViolations = result.violations.filter(
        v => v.type === "insufficient-contrast"
      );
      expect(contrastViolations).toHaveLength(0);
    });
  });

  describe("Form Input Labels", function() {
    const config: AccessibilityAuditConfig = {
      level: "AA",
      failureMode: "report",
      useBaseline: false,
    };
    const hierarchy: ViewHierarchyNode = { class: "View", children: [] };

    async function formInputViolations(elements: Element[]) {
      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config);
      return result.violations.filter(v => v.type === "unlabeled-form-input");
    }

    it("flags an EditText with no text, content-desc, or nearby TextView", async function() {
      const elements: Element[] = [
        { class: "android.widget.EditText", bounds: { left: 0, top: 0, right: 200, bottom: 60 } },
      ];
      expect(await formInputViolations(elements)).toHaveLength(1);
    });

    it("does NOT flag an EditText with a TextView within 50dp", async function() {
      const elements: Element[] = [
        { class: "android.widget.EditText", bounds: { left: 0, top: 100, right: 200, bottom: 160 } },
        // Horizontally aligned label just above the input (centers within 50dp on X).
        { class: "android.widget.TextView", text: "Name", bounds: { left: 0, top: 40, right: 200, bottom: 80 } },
      ];
      expect(await formInputViolations(elements)).toHaveLength(0);
    });

    it("flags an EditText whose only TextView is far away on both axes", async function() {
      const elements: Element[] = [
        { class: "android.widget.EditText", bounds: { left: 0, top: 0, right: 100, bottom: 60 } },
        // Label >50dp away in both X and Y from the input center.
        { class: "android.widget.TextView", text: "Far", bounds: { left: 500, top: 500, right: 600, bottom: 560 } },
      ];
      expect(await formInputViolations(elements)).toHaveLength(1);
    });

    it("ignores TextViews with no text when resolving labels", async function() {
      const elements: Element[] = [
        { class: "android.widget.EditText", bounds: { left: 0, top: 100, right: 200, bottom: 160 } },
        // Empty-text TextView must not count as a label even though it is adjacent.
        { class: "android.widget.TextView", bounds: { left: 0, top: 40, right: 200, bottom: 80 } },
      ];
      expect(await formInputViolations(elements)).toHaveLength(1);
    });
  });

  describe("Touch Target Size (parameterized)", function() {
    const hierarchy: ViewHierarchyNode = { class: "View", children: [] };

    // width × height × level → (violation?, severity). checkTouchTargetSizes
    // flags a clickable element when EITHER axis is < 44dp, and the severity is
    // `error` at AAA but `warning` at AA/A. Includes asymmetric-axis rows and the
    // AAA severity flip.
    it.each([
      [40, 40, "AA", true, "warning"],
      [44, 44, "AA", false, undefined],
      [100, 50, "AA", false, undefined],
      [44, 40, "AA", true, "warning"],   // height under, width exactly at bound
      [40, 44, "AA", true, "warning"],   // width under, height exactly at bound
      [43, 100, "AA", true, "warning"],  // single axis under
      [40, 40, "AAA", true, "error"],    // severity flip at AAA
      [44, 44, "AAA", false, undefined],
      [100, 43, "AAA", true, "error"],   // single axis under, AAA severity
    ])(
      "%ix%i at level %s flags=%p severity=%s",
      async function(width, height, level, expectViolation, expectedSeverity) {
        const elements: Element[] = [
          {
            bounds: { left: 0, top: 0, right: width as number, bottom: height as number },
            clickable: true,
            text: "Tap",
          },
        ];
        const config: AccessibilityAuditConfig = {
          level: level as AccessibilityAuditConfig["level"],
          failureMode: "report",
          useBaseline: false,
        };

        const result = await audit.audit(elements, hierarchy, undefined, "com.test", config);
        const sizeViolations = result.violations.filter(v => v.type === "touch-target-too-small");

        if (expectViolation) {
          expect(sizeViolations).toHaveLength(1);
          expect(sizeViolations[0].severity).toBe(expectedSeverity as "warning" | "error");
          expect(sizeViolations[0].message).toContain(`${width}x${height}dp`);
        } else {
          expect(sizeViolations).toHaveLength(0);
        }
      }
    );
  });

  describe("Heading Hierarchy", function() {
    const config: AccessibilityAuditConfig = {
      level: "AA",
      failureMode: "report",
      useBaseline: false,
    };

    // extractHeadings maps text height to a heading level using the bands
    // >48→h1, >36→h2, >28→h3, >22→h4, >18→h5, and only includes nodes taller
    // than 20dp. A violation is raised when a level is skipped (curr > prev + 1).
    function hierarchyWithHeadingHeights(heights: number[]): ViewHierarchyNode {
      return {
        class: "View",
        children: heights.map((h, i) => ({
          class: "android.widget.TextView",
          text: `Heading ${i}`,
          bounds: { left: 0, top: i * 200, right: 300, bottom: i * 200 + h },
        })),
      } as unknown as ViewHierarchyNode;
    }

    it.each([
      ["h1→h3 skips a level", [50, 30], 1],
      ["h1→h2 is contiguous", [50, 40], 0],
      ["h2→h4 skips a level", [40, 25], 1],
      ["h1→h2→h3 is contiguous", [50, 40, 30], 0],
      ["descending levels never skip", [30, 50], 0],
      ["a 20dp node is below the inclusion gate", [50, 20], 0],
      ["h1→h5 skips (21dp is included as h5)", [50, 21], 1],
      ["only one skip across three headings", [50, 30, 25], 1],
    ])(
      "%s",
      async function(_label, heights, expectedSkips) {
        const result = await audit.audit(
          [],
          hierarchyWithHeadingHeights(heights as number[]),
          undefined,
          "com.test",
          config
        );
        const skips = result.violations.filter(v => v.type === "heading-hierarchy-skip");
        expect(skips).toHaveLength(expectedSkips as number);
      }
    );
  });

  describe("Baseline Suppression", function() {
    const hierarchy: ViewHierarchyNode = { class: "View", children: [] };
    // Two clickable, unlabelled, undersized elements → 4 violations.
    const elements: Element[] = [
      { bounds: { left: 0, top: 0, right: 20, bottom: 20 }, clickable: true },
      { bounds: { left: 0, top: 30, right: 30, bottom: 60 }, clickable: true },
    ];

    async function baselineAndFindings() {
      const seed = new WcagAudit();
      const seedResult = await seed.audit(elements, hierarchy, undefined, "com.test", {
        level: "AA",
        failureMode: "report",
        useBaseline: false,
      });
      return seedResult;
    }

    it("suppresses violations whose fingerprint is present in the baseline", async function() {
      const seedResult = await baselineAndFindings();
      expect(seedResult.violations.length).toBeGreaterThanOrEqual(2);
      const suppressed = seedResult.violations[0];

      const stub = new StubBaselineManager({
        screenId: seedResult.screenId,
        violations: [suppressed],
        updatedAt: new Date().toISOString(),
      });
      const withBaseline = new WcagAudit(new FakeTimer(), stub);
      const result = await withBaseline.audit(elements, hierarchy, undefined, "com.test", {
        level: "AA",
        failureMode: "report",
        useBaseline: true,
      });

      expect(result.violations.find(v => v.fingerprint === suppressed.fingerprint)).toBeUndefined();
      expect(result.violations).toHaveLength(seedResult.violations.length - 1);
      expect(result.summary.baselinedViolations).toBe(1);
      expect(result.summary.totalViolations).toBe(seedResult.violations.length);
    });

    it("suppresses every violation and counts them when the whole finding set is baselined", async function() {
      const seedResult = await baselineAndFindings();

      const stub = new StubBaselineManager({
        screenId: seedResult.screenId,
        violations: seedResult.violations,
        updatedAt: new Date().toISOString(),
      });
      const withBaseline = new WcagAudit(new FakeTimer(), stub);
      const result = await withBaseline.audit(elements, hierarchy, undefined, "com.test", {
        level: "AA",
        failureMode: "report",
        useBaseline: true,
      });

      expect(result.violations).toHaveLength(0);
      expect(result.summary.baselinedViolations).toBe(seedResult.violations.length);
    });
  });
});
