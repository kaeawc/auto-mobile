import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  HierarchyDelegateContext,
} from "../../../src/features/observe/android/types";
import {
  applicationWindowSafeTapPoint,
  previewHierarchyHitTest,
} from "../../../src/features/observe/HierarchyHitTest";
import type { ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import capturedIme from "../../fixtures/android-ime-window/playground-gboard-api36.json";
import { nestedClickableHierarchy } from "../../fixtures/nestedClickableHierarchy";
import { loadAndroidHomeObserve } from "../../fixtures/observe/observeFixture";

const captured = loadAndroidHomeObserve().observe;
const observe = (viewHierarchy?: ViewHierarchyResult): ObserveResult => ({
  ...captured,
  screenSize: { width: 320, height: 240 },
  viewHierarchy,
});

describe("hierarchy hitTest preview", () => {
  test("ranks the top window before a smaller node in the lower window", () => {
    const hierarchy: ViewHierarchyResult = {
      hierarchy: { node: [] },
      windows: [
        {
          windowLayer: 1,
          hierarchy: {
            "resource-id": "lower",
            clickable: true,
            bounds: { left: 0, top: 0, right: 30, bottom: 30 },
          },
        },
        {
          windowLayer: 9,
          hierarchy: {
            "resource-id": "upper",
            clickable: true,
            bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          },
        },
      ],
    };
    const result = previewHierarchyHitTest({ x: 10, y: 10 }, observe(hierarchy), "android");
    expect(result.candidates.map((entry) => entry.elementId)).toEqual(["upper", "lower"]);
    expect(result.firstCandidate?.elementId).toBe("upper");
    expect(result.dispatchGuaranteed).toBe(false);
  });

  test("lists a node once with its owning window's rank on a captured linked-window hierarchy", () => {
    const hierarchy = new CtrlProxyHierarchy({
      timer: new FakeTimer(),
    } as HierarchyDelegateContext).convertToViewHierarchyResult(
      structuredClone(capturedIme) as AccessibilityHierarchy,
    );
    // The capture links each accessibility window to the merged tree's own root object.
    expect(hierarchy.windows).toHaveLength(3);
    expect(hierarchy.windows!.every((window) => window.hierarchy !== undefined)).toBe(true);
    const result = previewHierarchyHitTest(
      { x: 540, y: 60 },
      { ...captured, screenSize: { width: 1080, height: 2400 }, viewHierarchy: hierarchy },
      "android",
    );
    const countOf = (elementId: string) =>
      result.candidates.filter((entry) => entry.elementId === elementId);
    // Status-bar window (layer 2 -> rank 0) and the app window (layer 0 -> rank 2).
    expect(countOf("com.android.systemui:id/status_bar").map((entry) => entry.windowRank)).toEqual([
      0,
    ]);
    expect(countOf("android:id/content").map((entry) => entry.windowRank)).toEqual([2]);
    expect(countOf("s2-26081265664861f5").map((entry) => entry.windowRank)).toEqual([2]);
    expect(result.firstCandidate?.windowRank).toBe(0);
    // Only the three unlinked owner wrappers keep the merged roots' rank; no node is repeated
    // under it, and each is a distinct node from every linked-window node.
    const merged = result.candidates.filter((entry) => entry.windowRank === 3);
    expect(merged.map((entry) => entry.depth)).toEqual([0, 0]);
    expect(merged.map((entry) => entry.elementId)).toEqual([
      "s2-e9921704644e6fde",
      "s2-b1b5fa46393e3a9c",
    ]);
    expect(result.candidates).toHaveLength(16);
  });

  test("prefers the smallest containing interactive nested element", () => {
    const result = previewHierarchyHitTest(
      { x: 50, y: 40 },
      observe(nestedClickableHierarchy),
      "android",
    );
    expect(result.firstCandidate?.elementId).toBe("app:id/inner");
    expect(result.candidates.some((entry) => entry.label === "Wi-Fi")).toBe(true);
  });

  test("reports only an outer accessible canvas when drawing is opaque", () => {
    const hierarchy: ViewHierarchyResult = {
      hierarchy: {
        node: {
          "resource-id": "canvas",
          clickable: true,
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        },
      },
    };
    const result = previewHierarchyHitTest({ x: 20, y: 20 }, observe(hierarchy), "android");
    expect(result.candidates.map((entry) => entry.elementId)).toEqual(["canvas"]);
    expect(result.method).toBe("hierarchy-bounds");
  });

  test("returns null for an empty point and rejects invalid coordinates", () => {
    const result = previewHierarchyHitTest(
      { x: 300, y: 200 },
      observe(nestedClickableHierarchy),
      "android",
    );
    expect(result.firstCandidate).toBeNull();
    expect(result.candidates).toEqual([]);
    expect(() => previewHierarchyHitTest({ x: 320, y: 0 }, observe(), "android")).toThrow(
      "outside screen bounds",
    );
  });

  test("caps candidates at 25 with deterministic ties", () => {
    const hierarchy: ViewHierarchyResult = {
      hierarchy: {
        node: Array.from({ length: 30 }, (_, index) => ({
          "resource-id": `node-${index}`,
          clickable: true,
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        })),
      },
    };
    const result = previewHierarchyHitTest({ x: 10, y: 10 }, observe(hierarchy), "android");
    expect(result.candidates).toHaveLength(25);
    expect(result.candidates[0]?.elementId).toBe("node-0");
    expect(result.candidates[24]?.elementId).toBe("node-24");
  });

  test("uses the same Android rounding and iOS point geometry as tapAt", () => {
    expect(previewHierarchyHitTest({ x: 1.6, y: 2.5 }, observe(), "android").point).toEqual({
      x: 2,
      y: 3,
    });
    const ios = previewHierarchyHitTest({ x: 1.6, y: 2.5 }, observe(), "ios");
    expect(ios.point).toEqual({ x: 1.6, y: 2.5 });
    expect(ios.reference.unit).toBe("points");
  });
});

// Inline model tree: there is no existing capture of overlapping application dialogs.
test("application fallback avoids multiple covering windows and the IME", () => {
  const row = { text: "Row", bounds: { left: 0, top: 0, right: 400, bottom: 100 } };
  const dialog = { text: "Dialog", bounds: { left: 40, top: 0, right: 360, bottom: 100 } };
  const popup = { text: "Popup", bounds: { left: 0, top: 0, right: 40, bottom: 100 } };
  const hierarchy: ViewHierarchyResult = {
    hierarchy: { node: [row, dialog, popup] },
    windows: [
      { type: 1, windowLayer: 0, hierarchy: row },
      { type: 1, windowLayer: 2, hierarchy: dialog },
      { type: 1, windowLayer: 1, hierarchy: popup },
    ],
  };
  const target = new DefaultElementParser().parseNodeBounds(row)!;
  expect(
    applicationWindowSafeTapPoint(hierarchy, target, row.bounds, { x: 200, y: 50 }).point,
  ).toEqual({ x: 380, y: 50 });
  expect(
    applicationWindowSafeTapPoint(
      hierarchy,
      target,
      row.bounds,
      { x: 200, y: 50 },
      { left: 360, top: 0, right: 400, bottom: 100 },
    ),
  ).toEqual({ point: null, coveredBy: "Dialog" });
});
