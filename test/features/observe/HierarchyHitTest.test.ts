import { describe, expect, test } from "bun:test";
import { previewHierarchyHitTest } from "../../../src/features/observe/HierarchyHitTest";
import type { ObserveResult, ViewHierarchyResult } from "../../../src/models";
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
