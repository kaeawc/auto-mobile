import { describe, expect, test } from "bun:test";
import {
  SafeAreaAuditor,
  capLayoutWarnings,
  MAX_LAYOUT_WARNINGS,
} from "../../../../src/features/observe/audits/SafeAreaAuditor";
import type { LayoutWarning, ObserveResult } from "../../../../../src/models";

function observation(): ObserveResult {
  return {
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
        ] as any,
      },
    },
  };
}

describe("SafeAreaAuditor", () => {
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
    result.viewHierarchy!.hierarchy.node = [
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
    ] as any;

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
    result.viewHierarchy!.hierarchy.node = [
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
    ] as any;

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
    result.viewHierarchy!.hierarchy.node = [
      {
        text: "Last item",
        "view-id": "last-item",
        bounds: { left: 10, top: 180, right: 90, bottom: 200 },
      },
    ] as any;

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
    result.viewHierarchy!.hierarchy.node = [
      {
        text: "Partially inset",
        "view-id": "partial-item",
        bounds: { left: 10, top: 170, right: 90, bottom: 187 },
      },
    ] as any;

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
    result.viewHierarchy!.hierarchy.node = [
      {
        text: "Corner leaf",
        "view-id": "corner",
        bounds: { left: 0, top: 0, right: 40, bottom: 40 },
      },
    ] as any;

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

  test("collapses an under-inset container into its flagged leaf", () => {
    const result = observation();
    result.screenSize = { width: 1440, height: 3120 };
    result.insets!.systemBars!.visible = { top: 0, right: 0, bottom: 84, left: 0 };
    result.viewHierarchy!.hierarchy.node = [
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
    ] as any;

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
    result.viewHierarchy!.hierarchy.node = [
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
    ] as any;

    expect(new SafeAreaAuditor().inspect(result)).toEqual([
      expect.objectContaining({
        element: expect.objectContaining({ text: "Label" }),
        sides: ["bottom"],
      }),
    ]);
  });

  test("keeps an ancestor warning when its leaf does not cover every unsafe side", () => {
    const result = observation();
    result.viewHierarchy!.hierarchy.node = [
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
    ] as any;

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
    result.viewHierarchy!.hierarchy.node = [
      {
        text: "Previous page",
        clickable: "true",
        "view-id": "previous-page",
        bounds: { left: -100, top: 50, right: 0, bottom: 100 },
      },
    ] as any;

    expect(new SafeAreaAuditor().inspect(result)).toEqual([]);
  });

  test("only reports content overlap on sides with an inset", () => {
    const result = observation();
    result.viewHierarchy!.hierarchy.node = [
      {
        text: "Title",
        "view-id": "title",
        bounds: { left: -5, top: 8, right: 60, bottom: 28 },
      },
    ] as any;

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
    result.viewHierarchy!.hierarchy.node = [
      {
        $: {
          text: "Title",
          "view-id": "ios-title",
          bounds: { left: 10, top: 8, right: 60, bottom: 28 },
        },
      },
    ] as any;

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
    result.viewHierarchy!.hierarchy.node = [
      {
        $: {
          "view-id": "sdk-only-target",
          bounds: { left: 10, top: 8, right: 60, bottom: 28 },
        },
        extras: { "sdk.hasTapTarget": "true" },
      },
    ] as any;

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
