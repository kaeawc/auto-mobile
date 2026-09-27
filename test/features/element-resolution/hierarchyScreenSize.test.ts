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
