import type { ScreenSizeForOffscreenCheckOptions } from "../../models/ScreenSize";
import type { Element, ViewHierarchyResult } from "../../models";
import { boundsArea, intersectBounds } from "../../utils/bounds";
import { getHierarchySnapshot } from "../observe/HierarchyCapture";
import { getHierarchyNodeSource } from "../observe/output/elementProvenance";
import { hasVisibleBounds, isWithin } from "../utility/ElementResolverNodes";
import { screenSizeForOffscreenCheck } from "../utility/ElementGeometry";
import type { SearchableHierarchy } from "../utility/SearchableNode";
import { resolveViewHierarchyForSearch } from "../utility/viewHierarchySearch";

/**
 * The switch an iOS label match belongs to: the narrowest, rightmost toggle node of the
 * labelled row. A row-wide match taps its centre (the label), which never flips a UIKit
 * switch (#14659).
 */
export function findIosToggleControl(
  hierarchy: SearchableHierarchy,
  element: Element,
  text: string,
  {
    viewHierarchy,
    screenSizeOptions,
  }: { viewHierarchy: ViewHierarchyResult; screenSizeOptions?: ScreenSizeForOffscreenCheckOptions },
): Element {
  const nodes =
    getHierarchySnapshot(viewHierarchy)?.nodes ??
    hierarchy.project(resolveViewHierarchyForSearch(viewHierarchy)!);
  const source = getHierarchyNodeSource(element);
  const matched = nodes.find((node) => node.source === source);
  if (!matched?.bounds) {
    return element;
  }
  // The shared resolver can already pick an inner switch. Recover its labelled
  // row before comparing sibling controls, rather than treating it as the row.
  const row =
    nodes
      .filter(
        (node) =>
          node.rootGroup === matched.rootGroup &&
          node.affordances.includes("toggle") &&
          node.textFields.includes(text) &&
          node.bounds &&
          node.bounds.right - node.bounds.left > matched.bounds!.right - matched.bounds!.left &&
          (isWithin(matched, node, nodes) ||
            intersectBounds(node.bounds, matched.bounds!) !== null),
      )
      .sort((a, b) => boundsArea(a.bounds!) - boundsArea(b.bounds!))[0] ?? matched;
  const viewport = screenSizeForOffscreenCheck(viewHierarchy, {
    ...screenSizeOptions,
    platform: "ios",
  });
  // UIKit may serialize the switch as a sibling, protruding slightly past
  // the row's right edge. Keep association within this row and capture root.
  const controls = nodes.filter(
    (node) =>
      node.rootGroup === row.rootGroup &&
      node.affordances.includes("toggle") &&
      node.element &&
      hasVisibleBounds(node, { viewport }) &&
      boundsArea(node.bounds!) > 0 &&
      (node === row ||
        isWithin(node, row, nodes) ||
        intersectBounds(row.bounds!, node.bounds!) !== null),
  );
  controls.sort(
    (a, b) =>
      a.bounds!.right - a.bounds!.left - (b.bounds!.right - b.bounds!.left) ||
      b.bounds!.right - a.bounds!.right,
  );
  return controls[0]?.element ?? element;
}
