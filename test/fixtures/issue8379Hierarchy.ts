import type { ViewHierarchyNode, ViewHierarchyResult } from "../../src/models";

// values reported in issue #8379's 2026-10-01 device verification
export function issue8379Hierarchy(extraNodes: ViewHierarchyNode[] = []): ViewHierarchyResult {
  return {
    hierarchy: {
      node: {
        $: { class: "XCUIApplication", bounds: { left: 0, top: 0, right: 669, bottom: 951 } },
        node: [
          { $: { class: "UINavigationBar", bounds: { left: 0, top: 24, right: 951, bottom: 82 } } },
          {
            $: { class: "UICollectionView", bounds: { left: 0, top: 0, right: 951, bottom: 669 } },
          },
          ...extraNodes,
        ],
      },
    },
    screenScale: 3,
    nativeScale: 3,
    screenWidth: 669,
    screenHeight: 951,
    pixelWidth: 2853,
    pixelHeight: 2007,
  };
}

// Synthetic veto node, not captured from the issue: exceeds the swapped frame.
export const issue8379SyntheticOutlier: ViewHierarchyNode = {
  $: {
    class: "UICollectionViewCell",
    text: "outlier",
    bounds: { left: 800, top: 100, right: 1100, bottom: 200 },
  },
};
