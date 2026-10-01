import { expect, test } from "bun:test";
import { extractHierarchyScreenSize } from "../../../src/features/observe/hierarchyScreenSize";
import {
  normalizeIosHierarchy,
  projectActionableHierarchy,
} from "../../../src/features/observe/HierarchyNormalization";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
test("outer application bounds stay authoritative when cleanup collapses wrappers to one button", () => {
  const hierarchy = {
    hierarchy: {
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: {
        bounds: { left: 40, top: 300, right: 300, bottom: 370 },
        text: "Visible control",
        "resource-id": "capture.visible.control",
        clickable: true,
      },
    },
  };
  expect(extractHierarchyScreenSize(hierarchy)).toEqual({ width: 402, height: 874 });
  const projected = projectActionableHierarchy("ios", normalizeIosHierarchy(hierarchy));
  expect(
    new SearchableHierarchy()
      .project(projected)
      .some((node) => node.nativeId === "capture.visible.control"),
  ).toBe(true);
});
test("array-root captures retain fresh screen metadata when no enclosing bounds exist", () => {
  expect(
    extractHierarchyScreenSize({
      hierarchy: { node: [{ bounds: { left: 100, top: 100, right: 200, bottom: 200 } }] },
      screenWidth: 2400,
      screenHeight: 1080,
    }),
  ).toEqual({ width: 2400, height: 1080 });
});

// TODO(#8379): replace with a captured unfolded inner-panel hierarchy fixture.
test("swaps a stale Duo portrait root only when a child proves landscape", () => {
  const root = { left: 0, top: 0, right: 669, bottom: 951 };
  const child = { left: 0, top: 0, right: 867, bottom: 669 };
  expect(
    extractHierarchyScreenSize({
      hierarchy: { bounds: root, node: { bounds: root, node: [{ bounds: child }] } },
    }),
  ).toEqual({ width: 951, height: 669 });
  expect(
    extractHierarchyScreenSize({ hierarchy: { bounds: root, node: { node: [{ bounds: root }] } } }),
  ).toEqual({ width: 669, height: 951 });
});

test("keeps a single-panel portrait root when a carousel cell extends beyond its right edge", () => {
  const root = { left: 0, top: 0, right: 393, bottom: 852 };
  const carouselCell = { left: 350, top: 180, right: 620, bottom: 440 };
  expect(
    extractHierarchyScreenSize({
      hierarchy: { bounds: root, node: { bounds: root, node: [{ bounds: carouselCell }] } },
    }),
  ).toEqual({ width: 393, height: 852 });
});

test("synthetic Duo values resolve a sparse inner-panel element beyond a portrait root", () => {
  const root = { left: 0, top: 0, right: 669, bottom: 951 };
  const search = { left: 700, top: 20, right: 867, bottom: 76 };
  const hierarchy = {
    hierarchy: {
      bounds: root,
      node: {
        bounds: root,
        node: [{ bounds: search, "resource-id": "duo.search", clickable: true }],
      },
    },
  };
  expect(extractHierarchyScreenSize(hierarchy, true)).toEqual({ width: 951, height: 669 });
  const projected = projectActionableHierarchy("ios", hierarchy, true);
  expect(projected.screenWidth).toBe(951);
  expect(
    new SearchableHierarchy().project(projected).some((node) => node.nativeId === "duo.search"),
  ).toBe(true);
});

test("ordinary portrait overflow does not imply landscape on iOS or Android", () => {
  const root = { left: 0, top: 0, right: 393, bottom: 852 };
  const child = { left: 350, top: 100, right: 620, bottom: 380 };
  const hierarchy = {
    hierarchy: { bounds: root, node: { bounds: root, node: [{ bounds: child }] } },
  };
  expect(extractHierarchyScreenSize(hierarchy)).toEqual({ width: 393, height: 852 });
  expect(extractHierarchyScreenSize(hierarchy, false)).toEqual({ width: 393, height: 852 });
});
