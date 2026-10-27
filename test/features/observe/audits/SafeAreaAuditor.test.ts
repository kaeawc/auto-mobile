import { describe, expect, test } from "bun:test";
import {
  SafeAreaAuditor,
  capLayoutWarnings,
  MAX_LAYOUT_WARNINGS,
} from "../../../../src/features/observe/audits/SafeAreaAuditor";
import {
  BASELINE_ACCESSIBILITY_ACTIONS,
  hasInteractionAction,
} from "../../../../src/features/observe/audits/accessibilityActions";
import type { LayoutWarning, ObserveResult } from "../../../../src/models";
import {
  capturedFlatNodeForTest,
  createFlatHierarchyForTest,
  createObserveResultForTest,
  type FlatHierarchyNode,
} from "../flatHierarchyBuilders";
import { readFileSync } from "node:fs";
import { observeResultFromFixture } from "../../../helpers/observeFixture";
import { isTruthy } from "../../../../src/models/Element";
import { parseBounds } from "../../../../src/utils/bounds";

/** Real captures hang the screen's nodes under a single root node. */
function setRootNodes(result: ObserveResult, nodes: FlatHierarchyNode[]): void {
  result.viewHierarchy = createFlatHierarchyForTest({ hierarchy: { node: { node: nodes } } });
}

function observation(): ObserveResult {
  return createObserveResultForTest({
    updatedAt: 1,
    screenSize: { width: 100, height: 200 },
    systemInsets: { top: 20, right: 0, bottom: 20, left: 0 },
    activeWindow: { appId: "com.example", activityName: ".MainActivity", layoutSeqSum: 1 },
    insets: {
      available: true,
      source: "android-window-metrics",
      units: "physical-pixels",
      systemBars: {
        visible: { top: 20, right: 0, bottom: 20, left: 0 },
        stable: { top: 20, right: 0, bottom: 20, left: 0 },
      },
      systemGestures: { top: 0, right: 0, bottom: 0, left: 0 },
    },
    viewHierarchy: {
      hierarchy: {
        node: {
          node: [
            {
              text: "Title",
              "view-id": "title",
              bounds: { left: 10, top: 8, right: 60, bottom: 28 },
            },
            {
              text: "Continue",
              clickable: "true",
              "view-id": "continue",
              bounds: { left: 10, top: 170, right: 90, bottom: 196 },
            },
            {
              text: "System time",
              "resource-id": "com.android.systemui:id/clock",
              bounds: { left: 0, top: 0, right: 20, bottom: 20 },
            },
          ],
        },
      },
    },
  });
}

describe("SafeAreaAuditor", () => {
  describe("Android baseline accessibility actions", () => {
    function gestureObservation(attributes: FlatHierarchyNode): ObserveResult {
      const result = observation();
      result.insets!.systemBars!.visible = { top: 0, right: 0, bottom: 0, left: 0 };
      result.insets!.systemGestures = { top: 0, right: 0, bottom: 20, left: 0 };
      setRootNodes(result, [
        {
          text: "Bottom label",
          "view-id": "bottom-label",
          bounds: { left: 10, top: 180, right: 90, bottom: 200 },
          ...attributes,
        },
      ]);
      return result;
    }

    test.each([
      ["accessibility_focus"],
      ["clear_accessibility_focus"],
      ["select", "clear_selection"],
      [...BASELINE_ACCESSIBILITY_ACTIONS],
    ])("does not treat baseline signature %p as interaction", (...actions) => {
      expect(new SafeAreaAuditor().inspect(gestureObservation({ actions }))).toEqual([]);
    });

    test.each(["select", "clear_selection"])(
      "warns on a node whose only interaction is standalone %s (#14435)",
      (action) => {
        for (const actions of [
          [action],
          [action, "accessibility_focus", "clear_accessibility_focus"],
        ]) {
          expect(new SafeAreaAuditor().inspect(gestureObservation({ actions }))).toMatchObject([
            { type: "interaction-in-system-gesture-region", categories: ["interaction"] },
          ]);
        }
      },
    );

    test("keeps baseline-only text warnings as text under visible bars", () => {
      const result = gestureObservation({ actions: [...BASELINE_ACCESSIBILITY_ACTIONS] });
      expect(new SafeAreaAuditor().inspect(result)).toEqual([]);
      result.insets!.systemBars!.visible.bottom = 20;
      expect(new SafeAreaAuditor().inspect(result)).toMatchObject([
        { type: "important-content-under-inset", categories: ["text"] },
      ]);
    });

    test("does not warn on a baseline-only container under visible bars", () => {
      const result = gestureObservation({ text: "", actions: [...BASELINE_ACCESSIBILITY_ACTIONS] });
      result.insets!.systemBars!.visible.bottom = 20;
      expect(new SafeAreaAuditor().inspect(result)).toEqual([]);
    });

    test.each([
      "click",
      "long_click",
      "set_text",
      "scroll_forward",
      "scroll_backward",
      "expand",
      "collapse",
      "dismiss",
      "copy",
      "paste",
      "cut",
      "set_selection",
      "focus",
      "custom_vendor_action",
    ])("keeps real action %s interactive, alone or with baseline actions", (action) => {
      for (const actions of [[action], [...BASELINE_ACCESSIBILITY_ACTIONS, action]]) {
        expect(new SafeAreaAuditor().inspect(gestureObservation({ actions }))).toMatchObject([
          { type: "interaction-in-system-gesture-region", categories: ["interaction"] },
        ]);
      }
    });

    test.each(["clickable", "long-clickable", "checkable"])(
      "keeps %s interactive with baseline actions",
      (attribute) => {
        for (const value of [true, "true"]) {
          const result = gestureObservation({
            [attribute]: value,
            actions: [...BASELINE_ACCESSIBILITY_ACTIONS],
          });
          expect(new SafeAreaAuditor().inspect(result)).toMatchObject([
            { type: "interaction-in-system-gesture-region", categories: ["interaction"] },
          ]);
        }
      },
    );

    test("keeps SDK custom actions interactive without platform actions", () => {
      const result = gestureObservation({
        extras: { "sdk.accessibilityCustomActions": "Archive" },
      });
      expect(new SafeAreaAuditor().inspect(result)).toMatchObject([
        { type: "interaction-in-system-gesture-region", categories: ["interaction"] },
      ]);
    });

    const captures = [
      "android-overlay-window/app-layer-overlay-over-playground.raw.json",
      "android-overlay-window/floating-overlay-over-button-elevated.raw.json",
      "android-enabled/playground-disabled-control-api36.json",
      "android-launcher/launcher-home-emulator-5600.json",
    ].map((file) => {
      const result = observeResultFromFixture(
        JSON.parse(readFileSync(`${import.meta.dir}/../../../fixtures/${file}`, "utf8")),
        file,
      );
      const root = capturedFlatNodeForTest(result.viewHierarchy!.hierarchy.node!);
      result.viewHierarchy!.hierarchy.node = root;
      return { file, result, root };
    });

    test.each(captures)("only flags real interactions in captured $file", ({ result, root }) => {
      const nodes: FlatHierarchyNode[] = [];
      function index(node: FlatHierarchyNode): void {
        nodes.push(node);
        node.node?.forEach(index);
      }
      index(root);
      const warnings = new SafeAreaAuditor().inspect(result);
      const interactions = warnings.filter((warning) => warning.categories.includes("interaction"));
      expect(interactions.length).toBeGreaterThan(0);
      for (const warning of [...interactions, ...result.layoutWarnings!.warnings]) {
        if (!warning.categories.includes("interaction")) {
          continue;
        }
        const bounds = parseBounds(warning.element.bounds);
        const node = nodes.find(
          (candidate) =>
            (warning.element.viewId !== undefined
              ? candidate["view-id"] === warning.element.viewId ||
                candidate["resource-id"] === warning.element.viewId
              : candidate["resource-id"] === warning.element.resourceId) &&
            candidate.bounds?.left === bounds?.left &&
            candidate.bounds?.top === bounds?.top &&
            candidate.bounds?.right === bounds?.right &&
            candidate.bounds?.bottom === bounds?.bottom,
        );
        expect(node).toBeDefined();
        const hasFlag = [node?.clickable, node?.["long-clickable"], node?.checkable].some(
          (value) => (typeof value === "boolean" || typeof value === "string") && isTruthy(value),
        );
        const hasAction = Array.isArray(node?.actions) && hasInteractionAction(node.actions);
        expect(hasFlag || hasAction).toBe(true);
      }
    });
  });

  test("reports text and interactive content under visible bars, excluding system UI", () => {
    const warnings = new SafeAreaAuditor().inspect(observation());

    expect(warnings).toHaveLength(2);
    expect(warnings.map((warning) => warning.element.viewId)).toEqual(["title", "continue"]);
    expect(warnings[1]).toMatchObject({
      categories: ["text", "interaction"],
      sides: ["bottom"],
      insetTypes: ["systemBars"],
    });
  });

  test("excludes foreign resource IDs when nodes omit package metadata", () => {
    const result = observation();
    result.insets!.systemGestures = { top: 0, right: 0, bottom: 20, left: 0 };
    setRootNodes(result, [
      {
        text: "Compose",
        "view-id": "composer",
        "resource-id": "com.example:id/composer",
        bounds: { left: 10, top: 170, right: 90, bottom: 196 },
      },
      {
        text: "Back",
        "view-id": "ime-nav-back",
        "resource-id": "android:id/input_method_nav_back",
        clickable: "true",
        bounds: { left: 10, top: 170, right: 90, bottom: 196 },
      },
      {
        text: "q",
        "view-id": "ime-key",
        "resource-id": "com.google.android.inputmethod.latin:id/key_pos_q",
        clickable: "true",
        bounds: { left: 10, top: 170, right: 90, bottom: 196 },
      },
      {
        text: "Framework button",
        "view-id": "framework-button",
        "resource-id": "android:id/button1",
        clickable: "true",
        bounds: { left: 10, top: 8, right: 90, bottom: 28 },
      },
    ]);

    const warnings = new SafeAreaAuditor().inspect(result);

    expect(warnings).toHaveLength(2);
    expect(warnings.map((warning) => warning.element.viewId)).toEqual([
      "composer",
      "framework-button",
    ]);
  });

  test("downgrades large edge-to-edge containers when their content is inset", () => {
    const result = observation();
    result.insets!.systemBars!.visible = { top: 80, right: 0, bottom: 80, left: 0 };
    setRootNodes(result, [
      {
        "view-id": "close-sheet",
        "content-desc": "Close sheet",
        clickable: "true",
        bounds: { left: 0, top: 0, right: 100, bottom: 180 },
        node: [
          { text: "Forward", bounds: { left: 10, top: 80, right: 90, bottom: 110 } },
          { text: "Save", bounds: { left: 10, top: 110, right: 90, bottom: 120 } },
        ],
      },
    ]);

    expect(new SafeAreaAuditor().inspect(result)).toMatchObject([
      {
        element: { viewId: "close-sheet" },
        severity: "info",
        overlapPercent: 78,
      },
    ]);
  });

  test("keeps fully occluded leaf content at warning severity", () => {
    const result = observation();
    setRootNodes(result, [
      {
        text: "Last item",
        "view-id": "last-item",
        bounds: { left: 10, top: 180, right: 90, bottom: 200 },
      },
    ]);

    expect(new SafeAreaAuditor().inspect(result)).toMatchObject([
      {
        element: { viewId: "last-item" },
        severity: "warning",
        overlapPercent: 100,
      },
    ]);
  });

  test("downgrades leaf content with limited inset overlap", () => {
    const result = observation();
    setRootNodes(result, [
      {
        text: "Partially inset",
        "view-id": "partial-item",
        bounds: { left: 10, top: 170, right: 90, bottom: 187 },
      },
    ]);

    expect(new SafeAreaAuditor().inspect(result)).toMatchObject([
      {
        element: { viewId: "partial-item" },
        severity: "info",
        overlapPercent: 41,
      },
    ]);
  });

  test("does not double count a corner shared by safe-area insets", () => {
    const result = observation();
    result.insets = {
      available: true,
      source: "ios-sdk-safe-area",
      units: "points",
      safeArea: { top: 10, right: 0, bottom: 0, left: 10 },
    };
    setRootNodes(result, [
      {
        text: "Corner leaf",
        "view-id": "corner",
        bounds: { left: 0, top: 0, right: 40, bottom: 40 },
      },
    ]);

    expect(new SafeAreaAuditor().inspect(result)).toMatchObject([
      {
        element: { viewId: "corner" },
        severity: "info",
        overlapPercent: 44,
      },
    ]);
  });

  test("includes the effective inset and overflow for each reported side", () => {
    const warnings = new SafeAreaAuditor().inspect(observation());

    expect(warnings).toMatchObject([
      { element: { viewId: "title" }, overflowPx: { top: 12 }, insetPx: { top: 20 } },
      { element: { viewId: "continue" }, overflowPx: { bottom: 16 }, insetPx: { bottom: 20 } },
    ]);
  });

  describe("dedupe identity (#10040)", () => {
    function gestureHierarchy(
      nodes: Array<{
        contentDesc?: string;
        bounds: { left: number; top: number; right: number; bottom: number };
      }>,
    ): ObserveResult {
      const result = observation();
      result.insets!.systemBars!.visible = { top: 0, right: 0, bottom: 0, left: 0 };
      result.insets!.systemGestures = { top: 0, right: 0, bottom: 20, left: 0 };
      result.viewHierarchy!.hierarchy.node = {
        node: nodes.map(({ contentDesc, bounds }) => ({
          bounds,
          $: {
            clickable: "true",
            ...(contentDesc === undefined ? {} : { "content-desc": contentDesc }),
          },
        })),
      };
      return result;
    }

    test("keeps content-desc-only buttons with different bounds as separate warnings", () => {
      const warnings = new SafeAreaAuditor().inspect(
        gestureHierarchy([
          { contentDesc: "Home", bounds: { left: 0, top: 180, right: 30, bottom: 200 } },
          { contentDesc: "Search", bounds: { left: 35, top: 180, right: 65, bottom: 200 } },
          { contentDesc: "Profile", bounds: { left: 70, top: 180, right: 100, bottom: 200 } },
        ]),
      );

      expect(warnings.map((warning) => warning.element.contentDesc)).toEqual([
        "Home",
        "Search",
        "Profile",
      ]);
    });

    test("keeps fully unlabeled elements with different bounds as separate warnings", () => {
      const warnings = new SafeAreaAuditor().inspect(
        gestureHierarchy([
          { bounds: { left: 0, top: 180, right: 30, bottom: 200 } },
          { bounds: { left: 40, top: 180, right: 70, bottom: 200 } },
        ]),
      );

      expect(warnings).toHaveLength(2);
    });

    test("still collapses a true duplicate of the same unlabeled element", () => {
      const sameBounds = { left: 0, top: 180, right: 30, bottom: 200 };
      const warnings = new SafeAreaAuditor().inspect(
        gestureHierarchy([
          { contentDesc: "Home", bounds: sameBounds },
          { contentDesc: "Home", bounds: sameBounds },
        ]),
      );

      expect(warnings).toHaveLength(1);
    });
  });

  test("collapses an under-inset container into its flagged leaf", () => {
    const result = observation();
    result.screenSize = { width: 1440, height: 3120 };
    result.insets!.systemBars!.visible = { top: 0, right: 0, bottom: 84, left: 0 };
    setRootNodes(result, [
      {
        clickable: "true",
        bounds: { left: 0, top: 2987, right: 1440, bottom: 3120 },
        node: [
          {
            text: "Row 19",
            bounds: { left: 56, top: 3036, right: 521, bottom: 3106 },
          },
        ],
      },
    ]);

    expect(new SafeAreaAuditor().inspect(result)).toEqual([
      expect.objectContaining({
        element: expect.objectContaining({ text: "Row 19" }),
        sides: ["bottom"],
        overflowPx: { bottom: 70 },
        insetPx: { bottom: 84 },
        overlapPercent: 100,
      }),
    ]);
  });

  test("collapses an equal-bounds container into its flagged leaf", () => {
    const result = observation();
    setRootNodes(result, [
      {
        clickable: "true",
        bounds: { left: 1, top: 180, right: 99, bottom: 199 },
        node: [
          {
            text: "Label",
            bounds: { left: 1, top: 180, right: 99, bottom: 199 },
          },
        ],
      },
    ]);

    expect(new SafeAreaAuditor().inspect(result)).toEqual([
      expect.objectContaining({
        element: expect.objectContaining({ text: "Label" }),
        sides: ["bottom"],
      }),
    ]);
  });

  test("keeps an ancestor warning when its leaf does not cover every unsafe side", () => {
    const result = observation();
    setRootNodes(result, [
      {
        clickable: "true",
        bounds: { left: 1, top: 10, right: 99, bottom: 195 },
        node: [
          {
            text: "Label",
            bounds: { left: 1, top: 180, right: 99, bottom: 195 },
          },
        ],
      },
    ]);

    expect(new SafeAreaAuditor().inspect(result)).toMatchObject([
      {
        element: { bounds: { left: 1, top: 10, right: 99, bottom: 195 } },
        sides: ["top", "bottom"],
      },
      { element: { text: "Label" }, sides: ["bottom"] },
    ]);
  });

  test("returns no warnings when measurements are unavailable", () => {
    const result = observation();
    result.insets = { available: false, source: "unavailable", units: "unknown" };

    expect(new SafeAreaAuditor().inspect(result)).toEqual([]);
  });

  test("tolerates nullable Android runner inset categories", () => {
    const result = observation();
    result.insets!.displayCutout = null as never;
    result.insets!.systemGestures = null as never;

    expect(new SafeAreaAuditor().inspect(result)).toHaveLength(2);
  });

  test("does not attribute a zero-valued display cutout to bar overlap", () => {
    const result = observation();
    result.insets!.displayCutout = { top: 0, right: 0, bottom: 0, left: 0 };

    expect(new SafeAreaAuditor().inspect(result)[0]?.insetTypes).toEqual(["systemBars"]);
  });

  test("ignores fully off-screen content", () => {
    const result = observation();
    result.insets!.systemBars!.visible.left = 16;
    result.insets!.systemGestures!.left = 16;
    setRootNodes(result, [
      {
        text: "Previous page",
        clickable: "true",
        "view-id": "previous-page",
        bounds: { left: -100, top: 50, right: 0, bottom: 100 },
      },
    ]);

    expect(new SafeAreaAuditor().inspect(result)).toEqual([]);
  });

  test("only reports content overlap on sides with an inset", () => {
    const result = observation();
    setRootNodes(result, [
      {
        text: "Title",
        "view-id": "title",
        bounds: { left: -5, top: 8, right: 60, bottom: 28 },
      },
    ]);

    expect(new SafeAreaAuditor().inspect(result)).toMatchObject([
      { sides: ["top"], insetTypes: ["systemBars"] },
    ]);
  });

  test("uses the iOS safe area rather than Android bar fields", () => {
    const result = observation();
    result.insets = {
      available: true,
      source: "ios-sdk-safe-area",
      units: "points",
      safeArea: { top: 30, right: 0, bottom: 30, left: 0 },
      systemChrome: {
        visibility: "hidden",
        statusBar: "hidden",
        homeIndicatorAutoHideRequested: true,
        source: "ios-status-bar-manager",
      },
    };

    const warning = new SafeAreaAuditor().inspect(result)[0];
    expect(warning?.insetTypes).toEqual(["safeArea"]);
    expect(warning?.insetPx).toEqual({ top: 30 });
  });

  test("reads iOS CtrlProxy attributes from the hierarchy attribute bag", () => {
    const result = observation();
    result.insets = {
      available: true,
      source: "ios-sdk-safe-area",
      units: "points",
      safeArea: { top: 30, right: 0, bottom: 30, left: 0 },
    };
    setRootNodes(result, [
      {
        $: {
          text: "Title",
          "view-id": "ios-title",
          bounds: { left: 10, top: 8, right: 60, bottom: 28 },
        },
      },
    ]);

    expect(new SafeAreaAuditor().inspect(result)).toMatchObject([
      { element: { viewId: "ios-title" }, insetTypes: ["safeArea"], sides: ["top"] },
    ]);
  });

  test("reports iOS SDK-only tap targets as interactions", () => {
    const result = observation();
    result.insets = {
      available: true,
      source: "ios-sdk-safe-area",
      units: "points",
      safeArea: { top: 30, right: 0, bottom: 30, left: 0 },
    };
    setRootNodes(result, [
      {
        $: {
          "view-id": "sdk-only-target",
          bounds: { left: 10, top: 8, right: 60, bottom: 28 },
        },
        extras: { "sdk.hasTapTarget": "true" },
      },
    ]);

    expect(new SafeAreaAuditor().inspect(result)).toMatchObject([
      {
        element: { viewId: "sdk-only-target" },
        categories: ["interaction"],
        insetTypes: ["safeArea"],
      },
    ]);
  });
});

describe("capLayoutWarnings", () => {
  const makeWarning = (
    severity: LayoutWarning["severity"],
    topOverflow: number,
  ): LayoutWarning => ({
    type: "important-content-under-inset",
    severity,
    element: { text: "x", bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
    categories: ["text"],
    insetTypes: ["systemBars"],
    sides: ["top"],
    overflowPx: { top: topOverflow },
    insetPx: { top: 20 },
    overlapPercent: 100,
    confidence: "medium",
  });

  test("returns the envelope unchanged when at or under the cap", () => {
    const envelope = {
      scope: "full" as const,
      warnings: Array.from({ length: MAX_LAYOUT_WARNINGS }, () => makeWarning("info", 1)),
    };
    const result = capLayoutWarnings(envelope);
    expect(result).toBe(envelope);
    expect(result.total).toBeUndefined();
  });

  test("scope is 'truncated' with the pre-cap total when over the cap", () => {
    const warnings = Array.from({ length: MAX_LAYOUT_WARNINGS + 25 }, () => makeWarning("info", 1));
    const result = capLayoutWarnings({ scope: "full", warnings });
    expect(result.scope).toBe("truncated");
    expect(result.warnings).toHaveLength(MAX_LAYOUT_WARNINGS);
    expect(result.total).toBe(MAX_LAYOUT_WARNINGS + 25);
  });

  test("a scoped list that overflows stays 'scoped' and gains a total", () => {
    const warnings = Array.from({ length: MAX_LAYOUT_WARNINGS + 5 }, () => makeWarning("info", 1));
    const result = capLayoutWarnings({ scope: "scoped", warnings });
    expect(result.scope).toBe("scoped");
    expect(result.warnings).toHaveLength(MAX_LAYOUT_WARNINGS);
    expect(result.total).toBe(MAX_LAYOUT_WARNINGS + 5);
  });

  test("keeps the highest-severity, largest-overflow warnings when trimming", () => {
    // One high-priority (warning severity, large overflow) among many low ones.
    const low = Array.from({ length: MAX_LAYOUT_WARNINGS + 10 }, () => makeWarning("info", 1));
    const high = makeWarning("warning", 999);
    const result = capLayoutWarnings({ scope: "full", warnings: [...low, high] });
    expect(result.warnings).toHaveLength(MAX_LAYOUT_WARNINGS);
    expect(result.warnings).toContain(high);
  });
});
