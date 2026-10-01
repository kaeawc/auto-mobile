import { expect, test } from "bun:test";
import { extractHierarchyScreenSize } from "../../../src/features/observe/hierarchyScreenSize";
import {
  normalizeIosHierarchy,
  projectActionableHierarchy,
} from "../../../src/features/observe/HierarchyNormalization";
import { issue8379Hierarchy, issue8379SyntheticOutlier } from "../../fixtures/issue8379Hierarchy";
import type { ViewHierarchyResult } from "../../../src/models";
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

test("captured Duo hierarchy resolves landscape with and without the multi-panel flag", () => {
  const hierarchy = issue8379Hierarchy();
  expect(extractHierarchyScreenSize(hierarchy)).toEqual({ width: 951, height: 669 });
  for (const flag of [false, true]) {
    expect(extractHierarchyScreenSize(hierarchy, flag)).toEqual({ width: 951, height: 669 });
  }
});

test("pixels decide even when an extra node vetoes the tree proof", () => {
  const hierarchy = issue8379Hierarchy([issue8379SyntheticOutlier]);
  for (const flag of [false, true]) {
    expect(extractHierarchyScreenSize(hierarchy, flag)).toEqual({ width: 951, height: 669 });
  }
  const projected = projectActionableHierarchy("ios", normalizeIosHierarchy(hierarchy), true);
  expect(extractHierarchyScreenSize(projected)).toEqual({ width: 951, height: 669 });
  expect(projected.screenWidth).toBe(951);
});

function pixelHierarchy(
  width: number,
  height: number,
  metadata: Partial<ViewHierarchyResult>,
): ViewHierarchyResult {
  return {
    hierarchy: { node: { bounds: { left: 0, top: 0, right: width, bottom: height } } },
    ...metadata,
  };
}

test("ordinary portrait iPhone unchanged", () => {
  expect(
    extractHierarchyScreenSize(
      pixelHierarchy(393, 852, {
        pixelWidth: 1179,
        pixelHeight: 2556,
        nativeScale: 3,
        screenScale: 3,
      }),
    ),
  ).toEqual({ width: 393, height: 852 });
});

test("landscape iPhone unchanged", () => {
  expect(
    extractHierarchyScreenSize(
      pixelHierarchy(852, 393, {
        pixelWidth: 2556,
        pixelHeight: 1179,
        nativeScale: 3,
        screenScale: 3,
      }),
    ),
  ).toEqual({ width: 852, height: 393 });
});

test("Android unchanged with and without native pixel metadata", () => {
  for (const metadata of [{}, { pixelWidth: 951, pixelHeight: 669, nativeScale: 1 }]) {
    expect(extractHierarchyScreenSize(pixelHierarchy(669, 951, metadata))).toEqual({
      width: 669,
      height: 951,
    });
  }
});

test("carousel counter-example stays portrait with agreeing pixel fields", () => {
  const hierarchy = pixelHierarchy(393, 852, {
    pixelWidth: 1179,
    pixelHeight: 2556,
    nativeScale: 3,
    screenScale: 3,
  });
  hierarchy.hierarchy.node!.node = [{ bounds: { left: 350, top: 180, right: 620, bottom: 440 } }];
  expect(extractHierarchyScreenSize(hierarchy)).toEqual({ width: 393, height: 852 });
});

test("square-ish root never swaps", () => {
  for (const height of [500, 501]) {
    expect(
      extractHierarchyScreenSize(
        pixelHierarchy(500, height, {
          pixelWidth: height * 3,
          pixelHeight: 1500,
          nativeScale: 3,
          screenScale: 3,
        }),
      ),
    ).toEqual({ width: 500, height });
  }
});

test("Display Zoom pixels derived at nativeScale 3.14 for a portrait root do not swap", () => {
  expect(
    extractHierarchyScreenSize(
      pixelHierarchy(375, 812, {
        pixelWidth: 1178,
        pixelHeight: 2550,
        nativeScale: 3.14,
        screenScale: 3,
      }),
    ),
  ).toEqual({ width: 375, height: 812 });
});

test("pixel orientation uses nativeScale before screenScale and falls back for invalid nativeScale", () => {
  for (const nativeScale of [3, undefined, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    const hierarchy = issue8379Hierarchy([issue8379SyntheticOutlier]);
    hierarchy.nativeScale = nativeScale;
    if (nativeScale === 3) {
      hierarchy.screenScale = 2;
    }
    expect(extractHierarchyScreenSize(hierarchy)).toEqual({ width: 951, height: 669 });
  }
});

test("pixel orientation accepts one point of rounding but rejects larger disagreement", () => {
  for (const offset of [1, 1.01]) {
    const hierarchy = issue8379Hierarchy([issue8379SyntheticOutlier]);
    hierarchy.pixelWidth! += offset * 3;
    hierarchy.pixelHeight! -= offset * 3;
    expect(extractHierarchyScreenSize(hierarchy)).toEqual(
      offset === 1 ? { width: 951, height: 669 } : { width: 669, height: 951 },
    );
  }
});

test("invalid iOS scale or pixel fields do not override the tree proof", () => {
  const invalidMetadata: Partial<ViewHierarchyResult>[] = [
    { screenScale: Number.NaN },
    { screenScale: Number.POSITIVE_INFINITY },
    { screenScale: 0, nativeScale: undefined },
    { screenScale: -1, nativeScale: 0 },
    { pixelWidth: undefined },
    { pixelHeight: 0 },
    { pixelWidth: Number.NaN },
    { pixelHeight: Number.POSITIVE_INFINITY },
  ];
  for (const metadata of invalidMetadata) {
    expect(
      extractHierarchyScreenSize({
        ...issue8379Hierarchy([issue8379SyntheticOutlier]),
        ...metadata,
      }),
    ).toEqual({ width: 669, height: 951 });
  }
});
