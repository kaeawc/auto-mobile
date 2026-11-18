import { expect, test } from "bun:test";
import { extractHierarchyScreenSize } from "../../../src/features/observe/hierarchyScreenSize";
import {
  normalizeIosHierarchy,
  projectActionableHierarchy,
} from "../../../src/features/observe/HierarchyNormalization";
import { issue8379Hierarchy, issue8379SyntheticOutlier } from "../../fixtures/issue8379Hierarchy";
import type { ViewHierarchyResult } from "../../../src/models";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { swipeScreenSize } from "../../../src/features/action/swipeon/iosChromeInsets";
import { DefaultElementGeometry } from "../../../src/features/utility/ElementGeometry";
import { getScreenBounds } from "../../../src/utils/screenBounds";
import demosRawHierarchy from "../../fixtures/ios-duo/issue8379-demos-raw-hierarchy.json";
import modalSheetHierarchy from "../../fixtures/ios-duo/observe-inner-modal-sheet-hierarchy-18560.json";
import { childrenOf, nodeAttributes, nodeBounds } from "../../../src/models/ViewHierarchyResult";
import { parseBounds } from "../../../src/utils/bounds";
import { wireCapture } from "../../helpers/wireCapture";
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
    extractHierarchyScreenSize(
      wireCapture({
        hierarchy: { node: [{ bounds: { left: 100, top: 100, right: 200, bottom: 200 } }] },
        screenWidth: 2400,
        screenHeight: 1080,
      }),
    ),
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

// Captured 2026-10-08 on an unfolded iPhone Duo (iOS 27.1): the Playground Demos list has
// rows below the inner panel's bottom edge and the runner reports portrait pixels (#8379).
function capturedDemosHierarchy(): ViewHierarchyResult {
  return wireCapture(structuredClone(demosRawHierarchy));
}

test("captured Duo Demos list with rows past the panel bottom resolves landscape", () => {
  for (const flag of [false, true]) {
    expect(extractHierarchyScreenSize(capturedDemosHierarchy(), flag)).toEqual({
      width: 951,
      height: 669,
    });
  }
});

test("captured Duo Demos list swipes up inside the inner panel", () => {
  const viewHierarchy = projectActionableHierarchy(
    "ios",
    normalizeIosHierarchy(capturedDemosHierarchy()),
    true,
  );
  const observation = {
    screenSize: { width: 669, height: 951 },
    systemInsets: { top: 0, right: 84, bottom: 34, left: 0 },
    viewHierarchy,
  } as Parameters<typeof swipeScreenSize>[0]["observation"];
  const screen = swipeScreenSize({ observation, platform: "ios" })!;
  expect(screen).toEqual({ width: 951, height: 669 });
  const swipe = new DefaultElementGeometry().getSwipeWithinBounds(
    "up",
    getScreenBounds(screen, observation.systemInsets),
  );
  expect(swipe.startY).toBeLessThan(669);
  expect(swipe.endY).toBeLessThan(swipe.startY);
  expect(swipe.startX).toBeLessThan(951);
});

test("a wide but not exactly swapped child with portrait overflow stays portrait", () => {
  const root = { left: 0, top: 0, right: 669, bottom: 951 };
  const carousel = { left: 0, top: 0, right: 951, bottom: 700 };
  const row = { left: 0, top: 800, right: 669, bottom: 900 };
  expect(
    extractHierarchyScreenSize({
      hierarchy: {
        bounds: root,
        node: { bounds: root, node: [{ bounds: carousel }, { bounds: row }] },
      },
    }),
  ).toEqual({ width: 669, height: 951 });
});

test("an exactly swapped child still cannot extend past the swapped right edge", () => {
  const root = { left: 0, top: 0, right: 669, bottom: 951 };
  const swapped = { left: 0, top: 0, right: 951, bottom: 669 };
  const wide = { left: 0, top: 700, right: 1200, bottom: 760 };
  expect(
    extractHierarchyScreenSize({
      hierarchy: {
        bounds: root,
        node: { bounds: root, node: [{ bounds: swapped }, { bounds: wide }] },
      },
    }),
  ).toEqual({ width: 669, height: 951 });
});

function capturedModalSheetHierarchy(): ViewHierarchyResult {
  return wireCapture(structuredClone(modalSheetHierarchy));
}

test("captured Duo modal sheet resolves landscape only with multi-panel evidence", () => {
  expect(extractHierarchyScreenSize(capturedModalSheetHierarchy(), true)).toEqual({
    width: 951,
    height: 669,
  });
  expect(extractHierarchyScreenSize(capturedModalSheetHierarchy(), false)).toEqual({
    width: 669,
    height: 951,
  });
});

test("captured modal backdrop does not turn portrait content into landscape evidence", () => {
  const hierarchy = capturedModalSheetHierarchy();
  const stack = childrenOf(hierarchy.hierarchy.node!);
  while (stack.length > 0) {
    const node = stack.pop()!;
    const attributes = nodeAttributes(node);
    const bounds = parseBounds(nodeBounds(node));
    if (bounds && bounds.top < 951 && attributes["resource-id"] !== "PopoverDismissRegion") {
      node.bounds = {
        ...bounds,
        left: Math.min(bounds.left, 668),
        right: Math.min(bounds.right, 669),
      };
    }
    stack.push(...childrenOf(node));
  }
  expect(extractHierarchyScreenSize(hierarchy, true)).toEqual({ width: 669, height: 951 });
});

test("rows at the root bottom are ignored while their children can prove horizontal overflow", () => {
  const root = { left: 0, top: 0, right: 669, bottom: 951 };
  const row = { bounds: { left: 0, top: 951, right: 1200, bottom: 1300 } };
  const hierarchy = wireCapture({ hierarchy: { node: { bounds: root, node: [row] } } });
  expect(extractHierarchyScreenSize(hierarchy, true)).toEqual({ width: 669, height: 951 });
  const withChild = wireCapture({
    hierarchy: {
      node: {
        bounds: root,
        node: [{ ...row, node: { bounds: { left: 700, top: 20, right: 802, bottom: 80 } } }],
      },
    },
  });
  expect(extractHierarchyScreenSize(wireCapture(withChild), true)).toEqual({
    width: 951,
    height: 669,
  });
});

test("captured sheet keeps landscape evidence under single-child backdrop wrappers", () => {
  const hierarchy = capturedModalSheetHierarchy();
  const root = hierarchy.hierarchy.node!;
  const [backdrop, , scrollView] = childrenOf(root);
  nodeAttributes(scrollView).scrollable = true;
  const wrapped = wireCapture({
    ...hierarchy,
    hierarchy: { node: { ...root, node: { ...backdrop, node: scrollView } } },
  });
  expect(extractHierarchyScreenSize(wrapped, true)).toEqual({ width: 951, height: 669 });
});

test("oversized content clipped by a portrait scroll viewport cannot prove landscape", () => {
  const scrolledContent = (content: { left: number; top: number; right: number; bottom: number }) =>
    wireCapture({
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 393, bottom: 852 },
          node: [
            {
              bounds: { left: 0, top: 0, right: 393, bottom: 300 },
              scrollable: "true",
              node: [{ bounds: content }],
            },
          ],
        },
      },
    });
  for (const content of [
    { left: 0, top: 0, right: 900, bottom: 900 },
    { left: 0, top: 0, right: 852, bottom: 393 },
    { left: 0, top: 0, right: 1200, bottom: 600 },
  ]) {
    expect(extractHierarchyScreenSize(scrolledContent(content), false)).toEqual({
      width: 393,
      height: 852,
    });
    expect(extractHierarchyScreenSize(scrolledContent(content), true)).toEqual({
      width: 393,
      height: 852,
    });
  }
});
