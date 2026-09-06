/**
 * Unit tests for WcagAudit
 * Tests WCAG violation detection and audit functionality
 */

import { expect, describe, it, beforeEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { WcagAudit, type WcagBaselineStore } from "../../../src/features/accessibility/WcagAudit";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { Element } from "../../../src/models/Element";
import type {
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models/ViewHierarchyResult";
import type {
  AccessibilityAuditConfig,
  WcagViolation,
} from "../../../src/models/AccessibilityAudit";

const FIXTURE_ROOT = path.join(__dirname, "../../fixtures/observe");

function loadViewHierarchy(relativePath: string): ViewHierarchyResult {
  const raw = fs.readFileSync(path.join(FIXTURE_ROOT, relativePath), "utf8");
  const parsed = JSON.parse(raw) as { viewHierarchy: ViewHierarchyResult };
  return parsed.viewHierarchy;
}

/**
 * Baseline-store fake that returns a canned baseline without touching persistence.
 */
class StubBaselineManager implements WcagBaselineStore {
  constructor(private readonly stub: { violations: Pick<WcagViolation, "fingerprint">[] } | null) {}

  async getBaseline(
    _screenId: string,
  ): Promise<{ violations: Pick<WcagViolation, "fingerprint">[] } | null> {
    return this.stub;
  }

  async saveBaseline(_screenId: string, _violations: WcagViolation[]): Promise<void> {}

  async clearBaseline(_screenId: string): Promise<void> {}
}

describe("WcagAudit", function () {
  let audit: WcagAudit;

  beforeEach(function () {
    audit = new WcagAudit();
  });

  describe("Missing Content Descriptions", function () {
    it("should detect clickable elements without text or content-desc", async function () {
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
        (v) => v.type === "missing-content-description",
      );
      expect(contentDescViolations).toHaveLength(1);
    });

    it("should NOT flag elements with text", async function () {
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
        (v) => v.type === "missing-content-description",
      );
      expect(contentDescViolations).toHaveLength(0);
    });

    it("should NOT flag elements with content-desc", async function () {
      const elements: Element[] = [
        {
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          clickable: true,
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
        (v) => v.type === "missing-content-description",
      );
      expect(contentDescViolations).toHaveLength(0);
    });

    it("should NOT flag non-interactive elements without labels", async function () {
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
        (v) => v.type === "missing-content-description",
      );
      expect(contentDescViolations).toHaveLength(0);
    });

    it("should handle elements with only whitespace text", async function () {
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
        (v) => v.type === "missing-content-description",
      );
      // Current implementation treats whitespace as valid text (doesn't trim)
      expect(contentDescViolations).toHaveLength(0);
    });
  });

  describe("Touch Target Size", function () {
    it("should detect targets smaller than 44x44dp", async function () {
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

      // mdpi (160 DPI): 1dp == 1px, so bounds-as-dp assumptions below hold exactly.
      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config, 160);

      const sizeViolations = result.violations.filter((v) => v.type === "touch-target-too-small");
      expect(sizeViolations).toHaveLength(1);
    });

    it("should pass targets at exactly 44x44dp", async function () {
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

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config, 160);

      const sizeViolations = result.violations.filter((v) => v.type === "touch-target-too-small");
      expect(sizeViolations).toHaveLength(0);
    });

    it("should pass targets larger than 44x44dp", async function () {
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

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config, 160);

      const sizeViolations = result.violations.filter((v) => v.type === "touch-target-too-small");
      expect(sizeViolations).toHaveLength(0);
    });

    it("should only check clickable elements", async function () {
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

      const sizeViolations = result.violations.filter((v) => v.type === "touch-target-too-small");
      expect(sizeViolations).toHaveLength(0);
    });
  });

  describe("Summary Generation", function () {
    it("should generate correct summary statistics", async function () {
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

    it("should handle missing screenshot gracefully", async function () {
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
        (v) => v.type === "insufficient-contrast",
      );
      expect(contrastViolations).toHaveLength(0);
    });
  });

  describe("Form Input Labels", function () {
    const config: AccessibilityAuditConfig = {
      level: "AA",
      failureMode: "report",
      useBaseline: false,
    };
    const hierarchy: ViewHierarchyNode = { class: "View", children: [] };

    async function formInputViolations(elements: Element[], density?: number) {
      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config, density);
      return result.violations.filter((v) => v.type === "unlabeled-form-input");
    }

    it("flags an EditText with no text, content-desc, or nearby TextView", async function () {
      const elements: Element[] = [
        { class: "android.widget.EditText", bounds: { left: 0, top: 0, right: 200, bottom: 60 } },
      ];
      expect(await formInputViolations(elements)).toHaveLength(1);
    });

    it("does NOT flag an EditText with a label TextView directly above it", async function () {
      const elements: Element[] = [
        {
          class: "android.widget.EditText",
          bounds: { left: 0, top: 100, right: 200, bottom: 160 },
        },
        // Label sits directly above with a 20px vertical gap and full horizontal
        // overlap: bounding boxes are adjacent, so it is a genuine label.
        {
          class: "android.widget.TextView",
          text: "Name",
          bounds: { left: 0, top: 40, right: 200, bottom: 80 },
        },
      ];
      expect(await formInputViolations(elements)).toHaveLength(0);
    });

    it("flags an EditText whose only TextView is far away on both axes", async function () {
      const elements: Element[] = [
        { class: "android.widget.EditText", bounds: { left: 0, top: 0, right: 100, bottom: 60 } },
        // Label far from the input on both axes: bounding boxes are not adjacent.
        {
          class: "android.widget.TextView",
          text: "Far",
          bounds: { left: 500, top: 500, right: 600, bottom: 560 },
        },
      ];
      expect(await formInputViolations(elements)).toHaveLength(1);
    });

    // Regression for the `||` proximity bug: the old heuristic treated ANY
    // TextView sharing the input's horizontal band (|centerY diff| < 50) as a
    // label, even one on the opposite edge of the screen. That under-reports
    // unlabeled inputs (false negative). A real proximity metric must flag this.
    it("flags an EditText whose only TextView shares its row but is far to the side", async function () {
      const elements: Element[] = [
        { class: "android.widget.EditText", bounds: { left: 0, top: 0, right: 100, bottom: 60 } },
        // Same vertical band (identical centerY) but ~1900px away horizontally.
        {
          class: "android.widget.TextView",
          text: "Unrelated",
          bounds: { left: 2000, top: 0, right: 2100, bottom: 60 },
        },
      ];
      expect(await formInputViolations(elements)).toHaveLength(1);
    });

    // Companion to the above for the vertical axis: a TextView sharing the
    // input's column but far above it must not count as a label either.
    it("flags an EditText whose only TextView shares its column but is far above", async function () {
      const elements: Element[] = [
        {
          class: "android.widget.EditText",
          bounds: { left: 0, top: 2000, right: 100, bottom: 2060 },
        },
        // Same horizontal band (identical centerX) but ~1940px above.
        {
          class: "android.widget.TextView",
          text: "Header",
          bounds: { left: 0, top: 0, right: 100, bottom: 60 },
        },
      ];
      expect(await formInputViolations(elements)).toHaveLength(1);
    });

    it("picks the nearest TextView: a far one does not mask a genuinely absent label", async function () {
      const elements: Element[] = [
        { class: "android.widget.EditText", bounds: { left: 0, top: 0, right: 100, bottom: 60 } },
        // Two TextViews, both too far to be labels; the nearest still exceeds the gate.
        {
          class: "android.widget.TextView",
          text: "A",
          bounds: { left: 400, top: 0, right: 500, bottom: 60 },
        },
        {
          class: "android.widget.TextView",
          text: "B",
          bounds: { left: 0, top: 400, right: 100, bottom: 460 },
        },
      ];
      expect(await formInputViolations(elements)).toHaveLength(1);
    });

    it("does NOT flag when a genuine label sits beside an unrelated far TextView", async function () {
      const elements: Element[] = [
        {
          class: "android.widget.EditText",
          bounds: { left: 200, top: 100, right: 400, bottom: 160 },
        },
        // Adjacent label to the left (10px horizontal gap, rows overlap).
        {
          class: "android.widget.TextView",
          text: "Email",
          bounds: { left: 0, top: 100, right: 190, bottom: 160 },
        },
        // Unrelated far-away TextView must not change the result.
        {
          class: "android.widget.TextView",
          text: "Far",
          bounds: { left: 2000, top: 2000, right: 2100, bottom: 2060 },
        },
      ];
      expect(await formInputViolations(elements)).toHaveLength(0);
    });

    it("ignores TextViews with no text when resolving labels", async function () {
      const elements: Element[] = [
        {
          class: "android.widget.EditText",
          bounds: { left: 0, top: 100, right: 200, bottom: 160 },
        },
        // Empty-text TextView must not count as a label even though it is adjacent.
        { class: "android.widget.TextView", bounds: { left: 0, top: 40, right: 200, bottom: 80 } },
      ];
      expect(await formInputViolations(elements)).toHaveLength(1);
    });

    // Density scaling: on a 3x (480 DPI) device a 120px gap is only 40dp — a
    // normally-spaced label. The gate scales to 50dp*3 = 150px, so it counts.
    // A fixed 50px gate (the pre-density bug) would reject it, producing a false
    // "unlabeled" violation.
    const highDensityLabel: Element[] = [
      { class: "android.widget.EditText", bounds: { left: 0, top: 200, right: 200, bottom: 260 } },
      // Label directly above with a 120px vertical gap (label.bottom 80, input.top 200).
      {
        class: "android.widget.TextView",
        text: "Name",
        bounds: { left: 0, top: 20, right: 200, bottom: 80 },
      },
    ];

    it("does NOT flag a normally-spaced label on a high-density (480 DPI) device", async function () {
      // 120px gap == 40dp <= 50dp gate scaled to 150px.
      expect(await formInputViolations(highDensityLabel, 480)).toHaveLength(0);
    });

    it("flags the same 120px gap as unlabeled on a low-density (160 DPI) device", async function () {
      // At mdpi 1dp == 1px, so a 120px gap is a genuine 120dp away: not a label.
      expect(await formInputViolations(highDensityLabel, 160)).toHaveLength(1);
    });
  });

  describe("Touch Target Size (parameterized)", function () {
    const hierarchy: ViewHierarchyNode = { class: "View", children: [] };

    // width × height × level → (violation?, severity). checkTouchTargetSizes
    // flags a clickable element when EITHER axis is < 44dp, and the severity is
    // `error` at AAA but `warning` at AA/A. Includes asymmetric-axis rows and the
    // AAA severity flip.
    it.each([
      [40, 40, "AA", true, "warning"],
      [44, 44, "AA", false, undefined],
      [100, 50, "AA", false, undefined],
      [44, 40, "AA", true, "warning"], // height under, width exactly at bound
      [40, 44, "AA", true, "warning"], // width under, height exactly at bound
      [43, 100, "AA", true, "warning"], // single axis under
      [40, 40, "AAA", true, "error"], // severity flip at AAA
      [44, 44, "AAA", false, undefined],
      [100, 43, "AAA", true, "error"], // single axis under, AAA severity
    ])(
      "%ix%i at level %s flags=%p severity=%s",
      async function (width, height, level, expectViolation, expectedSeverity) {
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

        // mdpi (160 DPI): 1dp == 1px, so bounds-as-dp labels above hold exactly.
        const result = await audit.audit(elements, hierarchy, undefined, "com.test", config, 160);
        const sizeViolations = result.violations.filter((v) => v.type === "touch-target-too-small");

        if (expectViolation) {
          expect(sizeViolations).toHaveLength(1);
          expect(sizeViolations[0].severity).toBe(expectedSeverity as "warning" | "error");
          expect(sizeViolations[0].message).toContain(`${width}x${height}dp`);
        } else {
          expect(sizeViolations).toHaveLength(0);
        }
      },
    );
  });

  describe("Touch Target Size (density scaling)", function () {
    const hierarchy: ViewHierarchyNode = { class: "View", children: [] };
    const config: AccessibilityAuditConfig = {
      level: "AA",
      failureMode: "report",
      useBaseline: false,
    };

    // 44dp minimum, scaled by density/160. At xxhdpi (480 DPI) that is 132px.
    it("flags a 100x100px target on an xxhdpi (480 DPI) device (33dp, below the 44dp gate)", async function () {
      const elements: Element[] = [
        {
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          clickable: true,
          text: "Small",
        },
      ];

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config, 480);
      const sizeViolations = result.violations.filter((v) => v.type === "touch-target-too-small");

      expect(sizeViolations).toHaveLength(1);
      // 100px at 480 DPI is 33dp (100 * 160 / 480), not 100dp.
      expect(sizeViolations[0].message).toContain("33x33dp");
      expect(sizeViolations[0].message).not.toContain("100x100dp");
    });

    it("passes a 140x140px target on an xxhdpi (480 DPI) device (>= the 132px/44dp gate)", async function () {
      const elements: Element[] = [
        {
          bounds: { left: 0, top: 0, right: 140, bottom: 140 },
          clickable: true,
          text: "Big enough",
        },
      ];

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config, 480);
      const sizeViolations = result.violations.filter((v) => v.type === "touch-target-too-small");

      expect(sizeViolations).toHaveLength(0);
    });

    it("treats mdpi (160 DPI) as 1dp == 1px", async function () {
      const elements: Element[] = [
        {
          bounds: { left: 0, top: 0, right: 40, bottom: 40 },
          clickable: true,
          text: "Small",
        },
      ];

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config, 160);
      const sizeViolations = result.violations.filter((v) => v.type === "touch-target-too-small");

      expect(sizeViolations).toHaveLength(1);
      expect(sizeViolations[0].message).toContain("40x40dp");
    });

    it("falls back to a sensible default density when none is reported, consistent with checkFormInputLabels", async function () {
      // No density passed at all — exercises the same fallback path as
      // labelGapThresholdPx's FALLBACK_DENSITY_DPI (320 == xhdpi/2x), so a
      // 44dp target on that assumed density is ~88px.
      const elements: Element[] = [
        {
          bounds: { left: 0, top: 0, right: 88, bottom: 88 }, // exactly 44dp at 320 DPI
          clickable: true,
          text: "Perfect",
        },
      ];

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config);
      const sizeViolations = result.violations.filter((v) => v.type === "touch-target-too-small");

      expect(sizeViolations).toHaveLength(0);
    });

    it("never rounds a failing dimension's reported dp up to the minimum", async function () {
      // 115px at 420 DPI is 43.81dp — under the 44dp gate (115.5px), so this
      // must violate. Rounding to nearest would display "44x44dp", which
      // reads as meeting "minimum: 44x44dp" right next to it.
      const elements: Element[] = [
        {
          bounds: { left: 0, top: 0, right: 115, bottom: 115 },
          clickable: true,
          text: "Borderline",
        },
      ];

      const result = await audit.audit(elements, hierarchy, undefined, "com.test", config, 420);
      const sizeViolations = result.violations.filter((v) => v.type === "touch-target-too-small");

      expect(sizeViolations).toHaveLength(1);
      expect(sizeViolations[0].message).toBe(
        "Touch target is too small: 43x43dp (minimum: 44x44dp)",
      );
      expect(sizeViolations[0].details.actualSize).toEqual({ width: 43, height: 43 });
    });
  });

  describe("Heading Hierarchy", function () {
    const config: AccessibilityAuditConfig = {
      level: "AA",
      failureMode: "report",
      useBaseline: false,
    };

    // The height-based heading heuristic was removed (issue #3507): Android has
    // no native heading semantics, so inferring heading levels from absolute
    // pixel text height produced density-dependent, arbitrary "hierarchy skip"
    // violations. These tests pin that NO heading violations are ever produced,
    // regardless of text sizes in the hierarchy.
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
      ["what would have been h1→h3", [50, 30]],
      ["what would have been h1→h2", [50, 40]],
      ["what would have been h2→h4", [40, 25]],
      ["three descending sizes", [50, 40, 30]],
      ["ascending sizes", [30, 50]],
      ["small nodes near the old inclusion gate", [50, 20, 21]],
    ])("produces no heading violations for %s", async function (_label, heights) {
      const result = await audit.audit(
        [],
        hierarchyWithHeadingHeights(heights as number[]),
        undefined,
        "com.test",
        config,
      );
      const headingViolations = result.violations.filter((v) => v.type.includes("heading"));
      expect(headingViolations).toHaveLength(0);
    });

    it("does not report heading-hierarchy-skip in the byType summary", async function () {
      const result = await audit.audit(
        [],
        hierarchyWithHeadingHeights([50, 30, 25]),
        undefined,
        "com.test",
        config,
      );
      // The heading violation type is no longer produced or tracked.
      expect(
        (result.summary.byType as Record<string, number>)["heading-hierarchy-skip"],
      ).toBeUndefined();
    });
  });

  describe("Screen ID generation (#6252)", function () {
    /**
     * Records the `screenId` passed to `getBaseline` so tests can assert on it
     * without reaching into the private `generateScreenId` method.
     */
    class RecordingBaselineManager implements WcagBaselineStore {
      lastScreenId: string | undefined;

      async getBaseline(
        screenId: string,
      ): Promise<{ violations: Pick<WcagViolation, "fingerprint">[] } | null> {
        this.lastScreenId = screenId;
        return null;
      }

      async saveBaseline(): Promise<void> {}
      async clearBaseline(): Promise<void> {}
    }

    it("derives the screen id from the node's $ attributes, not top-level fields", async function () {
      // Real hierarchies carry attributes under `$` (xml2js/CtrlProxy shape), not
      // as top-level `class`/`resource-id` fields directly on the node. Before
      // #6252, `generateScreenId` read `rootNode.class` / `rootNode["resource-id"]`
      // directly, which are always undefined on this shape, so every screen
      // collapsed to the same "unknown:" id.
      const hierarchy: ViewHierarchyNode = {
        $: { class: "com.example.MainActivity", "resource-id": "root-container" },
      };
      const recorder = new RecordingBaselineManager();
      const withRecorder = new WcagAudit(new FakeTimer(), recorder);

      await withRecorder.audit([], hierarchy, undefined, "com.test", {
        level: "AA",
        failureMode: "report",
        useBaseline: true,
      });

      expect(recorder.lastScreenId).toBe("com.test:com.example.MainActivity:root-container");
    });

    it("falls back to 'unknown' when $ attributes are absent", async function () {
      const hierarchy: ViewHierarchyNode = { $: {} };
      const recorder = new RecordingBaselineManager();
      const withRecorder = new WcagAudit(new FakeTimer(), recorder);

      await withRecorder.audit([], hierarchy, undefined, "com.test", {
        level: "AA",
        failureMode: "report",
        useBaseline: true,
      });

      expect(recorder.lastScreenId).toBe("com.test:unknown:");
    });

    it("derives the screen id from flat attributes (CtrlProxy accessibility shape)", async function () {
      // CtrlProxyHierarchy.convertAccessibilityNode never creates `$` — it
      // writes `class`/`resource-id` directly on the node. A rootNode.$?.class-only
      // read (the fix's initial, over-corrected form) leaves this always
      // undefined on the accessibility path, re-collapsing every screen to
      // "unknown:" — the very bug #6252 was fixing, now on the other source.
      const hierarchy = {
        $: {},
        class: "com.example.MainActivity",
        "resource-id": "root-container",
      } as unknown as ViewHierarchyNode;
      const recorder = new RecordingBaselineManager();
      const withRecorder = new WcagAudit(new FakeTimer(), recorder);

      await withRecorder.audit([], hierarchy, undefined, "com.test", {
        level: "AA",
        failureMode: "report",
        useBaseline: true,
      });

      expect(recorder.lastScreenId).toBe("com.test:com.example.MainActivity:root-container");
    });

    it("prefers `$` attributes over flat ones when both are present", async function () {
      const hierarchy = {
        $: { class: "com.example.XmlActivity", "resource-id": "xml-root" },
        class: "com.example.FlatActivity",
        "resource-id": "flat-root",
      } as unknown as ViewHierarchyNode;
      const recorder = new RecordingBaselineManager();
      const withRecorder = new WcagAudit(new FakeTimer(), recorder);

      await withRecorder.audit([], hierarchy, undefined, "com.test", {
        level: "AA",
        failureMode: "report",
        useBaseline: true,
      });

      expect(recorder.lastScreenId).toBe("com.test:com.example.XmlActivity:xml-root");
    });
  });

  describe("Baseline root selection on multi-window hierarchies (#6274)", function () {
    /**
     * Records the `screenId` passed to `getBaseline` so tests can assert on it
     * without reaching into the private `generateScreenId`/`resolveRootNode`
     * methods.
     */
    class RecordingBaselineManager implements WcagBaselineStore {
      lastScreenId: string | undefined;

      async getBaseline(
        screenId: string,
      ): Promise<{ violations: Pick<WcagViolation, "fingerprint">[] } | null> {
        this.lastScreenId = screenId;
        return null;
      }

      async saveBaseline(): Promise<void> {}
      async clearBaseline(): Promise<void> {}
    }

    async function screenIdFor(
      hierarchy: ViewHierarchyNode,
      packageName: string,
      windows?: ViewHierarchyResult["windows"],
    ): Promise<string> {
      const recorder = new RecordingBaselineManager();
      const withRecorder = new WcagAudit(new FakeTimer(), recorder);
      await withRecorder.audit([], hierarchy, undefined, packageName, {
        level: "AA",
        failureMode: "report",
        useBaseline: true,
      });
      return recorder.lastScreenId!;
    }

    it("picks the focused non-SystemUI window root over the SystemUI status-bar wrapper (windows[] present)", async function () {
      // Two window roots, in the order a real capture produces them: the app
      // content root first, the SystemUI status bar last — matching
      // test/fixtures/observe/android-home.json's shape. Picking the LAST
      // entry (the pre-fix behavior) lands on the attribute-less SystemUI
      // wrapper.
      const appRoot: ViewHierarchyNode = {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        className: "com.example.AppContentRoot",
      } as unknown as ViewHierarchyNode;
      const systemUiRoot: ViewHierarchyNode = {
        bounds: { left: 0, top: 0, right: 1080, bottom: 63 },
      } as unknown as ViewHierarchyNode;
      const hierarchy: ViewHierarchyNode = { node: [appRoot, systemUiRoot] };
      const windows: ViewHierarchyResult["windows"] = [
        { isFocused: true, isActive: true, type: 1, bounds: appRoot.bounds },
        { isFocused: false, isActive: false, type: 3, bounds: systemUiRoot.bounds },
      ];

      const screenId = await screenIdFor(hierarchy, "com.test", windows);

      expect(screenId).toBe("com.test:com.example.AppContentRoot:");
      expect(screenId).not.toContain(":unknown:");
    });

    it("falls back to the largest-bounds root when no windows[] metadata is present", async function () {
      // Mirrors test/fixtures/observe/diff/scroll-before.json: the app root is
      // full-screen, the SystemUI root is a thin status-bar sliver, and no
      // `windows[]` metadata is available to match against.
      const appRoot: ViewHierarchyNode = {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        className: "com.example.AppContentRoot",
      } as unknown as ViewHierarchyNode;
      const systemUiRoot: ViewHierarchyNode = {
        bounds: { left: 0, top: 0, right: 1080, bottom: 63 },
      } as unknown as ViewHierarchyNode;
      const hierarchy: ViewHierarchyNode = { node: [appRoot, systemUiRoot] };

      const screenId = await screenIdFor(hierarchy, "com.test", undefined);

      expect(screenId).toBe("com.test:com.example.AppContentRoot:");
      expect(screenId).not.toContain(":unknown:");
    });

    it("does not let the SystemUI root's screenId collide with the app root's on android-home.json", async function () {
      const viewHierarchy = loadViewHierarchy("android-home.json");
      const screenId = await screenIdFor(
        viewHierarchy.hierarchy,
        "com.google.android.apps.nexuslauncher",
        viewHierarchy.windows,
      );

      // Pre-fix, this always produced "<appId>:unknown:" because the last
      // array entry (the SystemUI status bar) carries no class/resource-id.
      expect(screenId).not.toBe("com.google.android.apps.nexuslauncher:unknown:");
      expect(screenId).not.toContain(":unknown:");
    });

    it("derives distinct, non-'unknown' screen ids for distinct multi-root screens (android-home.json vs scroll-before.json)", async function () {
      const home = loadViewHierarchy("android-home.json");
      const scroll = loadViewHierarchy("diff/scroll-before.json");

      const homeScreenId = await screenIdFor(
        home.hierarchy,
        "com.google.android.apps.nexuslauncher",
        home.windows,
      );
      const scrollScreenId = await screenIdFor(
        scroll.hierarchy,
        "dev.jasonpearson.automobile.playground",
        scroll.windows,
      );

      expect(homeScreenId).not.toContain(":unknown:");
      expect(scrollScreenId).not.toContain(":unknown:");
      expect(homeScreenId).not.toBe(scrollScreenId);
    });
  });

  describe("Baseline Suppression", function () {
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

    it("suppresses violations whose fingerprint is present in the baseline", async function () {
      const seedResult = await baselineAndFindings();
      expect(seedResult.violations.length).toBeGreaterThanOrEqual(2);
      const suppressed = seedResult.violations[0];

      const stub = new StubBaselineManager({
        violations: [suppressed],
      });
      const withBaseline = new WcagAudit(new FakeTimer(), stub);
      const result = await withBaseline.audit(elements, hierarchy, undefined, "com.test", {
        level: "AA",
        failureMode: "report",
        useBaseline: true,
      });

      expect(
        result.violations.find((v) => v.fingerprint === suppressed.fingerprint),
      ).toBeUndefined();
      expect(result.violations).toHaveLength(seedResult.violations.length - 1);
      expect(result.summary.baselinedViolations).toBe(1);
      expect(result.summary.totalViolations).toBe(seedResult.violations.length);
    });

    it("suppresses every violation and counts them when the whole finding set is baselined", async function () {
      const seedResult = await baselineAndFindings();

      const stub = new StubBaselineManager({
        violations: seedResult.violations,
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
