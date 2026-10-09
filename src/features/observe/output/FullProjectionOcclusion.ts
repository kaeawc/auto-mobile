import type { Element } from "../../../models/Element";
import type { ObserveResult } from "../../../models/ObserveResult";
import type { ViewHierarchyNode } from "../../../models/ViewHierarchyResult";
import { visibleTapBounds } from "../../utility/ElementGeometry";
import {
  applicationWindowCoverIndex,
  isFullyCoveredByApplicationWindow,
} from "../ApplicationWindowCover";
import { getHierarchyNodeSource } from "./elementProvenance";

// The full projection carries the skeleton's `occluded: true` signal (owner decision 2026-10-08,
// #10715: observe never offers a row tapOn refuses). The skeleton drops the row's affordances; the
// full projection has no affordance list, so it drops the accessibility `actions` and keeps every
// other captured field.

type ActionableCategory = "clickable" | "scrollable";
const ACTIONABLE_CATEGORIES: readonly ActionableCategory[] = ["clickable", "scrollable"];

function asArray(node: ViewHierarchyNode | ViewHierarchyNode[] | undefined): ViewHierarchyNode[] {
  if (!node) {
    return [];
  }
  return Array.isArray(node) ? node : [node];
}

function markOccluded(target: Record<string, unknown>): void {
  target.occluded = true;
  delete target.actions;
}

/** Source nodes of actionable rows that application windows or AutoMobile overlays fully cover. */
function coveredSources(
  elements: NonNullable<ObserveResult["elements"]>,
  source: ObserveResult,
): { covered: Set<ViewHierarchyNode>; indexes: Map<ActionableCategory, Set<number>> } {
  const covered = new Set<ViewHierarchyNode>();
  const indexes = new Map<ActionableCategory, Set<number>>();
  // Project the capture once for every row, not once per row.
  const coverIndex = applicationWindowCoverIndex(source.viewHierarchy!);
  for (const category of ACTIONABLE_CATEGORIES) {
    const hits = new Set<number>();
    (elements[category] as Element[]).forEach((element, index) => {
      const node = getHierarchyNodeSource(element);
      const bounds = visibleTapBounds(element.bounds, source.screenSize);
      if (
        node &&
        bounds &&
        isFullyCoveredByApplicationWindow(
          source.viewHierarchy!,
          element,
          bounds,
          "touch",
          coverIndex,
        )
      ) {
        covered.add(node);
        hits.add(index);
      }
    });
    indexes.set(category, hits);
  }
  return { covered, indexes };
}

/** Walk a source tree and its JSON clone in lockstep, marking the clone of each covered node. */
function markClonedNodes(
  sourceNodes: ViewHierarchyNode[],
  clonedNodes: ViewHierarchyNode[],
  covered: ReadonlySet<ViewHierarchyNode>,
): void {
  if (sourceNodes.length !== clonedNodes.length) {
    return;
  }
  sourceNodes.forEach((node, index) => {
    if (covered.has(node)) {
      markOccluded(clonedNodes[index]);
    }
    markClonedNodes(asArray(node.node), asArray(clonedNodes[index].node), covered);
  });
}

function markClonedTree(
  out: ObserveResult,
  source: ObserveResult,
  covered: ReadonlySet<ViewHierarchyNode>,
): void {
  const sourceTree = source.viewHierarchy;
  const clonedTree = out.viewHierarchy;
  if (!sourceTree || !clonedTree) {
    return;
  }
  markClonedNodes(
    asArray(sourceTree.hierarchy?.node),
    asArray(clonedTree.hierarchy?.node),
    covered,
  );
  const sourceWindows = sourceTree.windows ?? [];
  (clonedTree.windows ?? []).forEach((window, index) => {
    markClonedNodes(asArray(sourceWindows[index]?.hierarchy), asArray(window.hierarchy), covered);
  });
}

/**
 * Mark, on the already-cloned full output `out`, every actionable row that `source`'s windows fully
 * cover: `occluded: true` and no `actions`, on both its `elements` entry and its hierarchy node.
 * `elements` must be the provenance-carrying collection of `source` (Android only).
 */
export function markOccludedRowsOnFullProjection(
  out: ObserveResult,
  source: ObserveResult,
  elements: ObserveResult["elements"],
): void {
  if (!elements || !out.elements || !source.viewHierarchy?.windows?.length) {
    return;
  }
  const { covered, indexes } = coveredSources(elements, source);
  if (covered.size === 0) {
    return;
  }
  for (const category of ACTIONABLE_CATEGORIES) {
    out.elements[category]
      .filter((_, index) => indexes.get(category)?.has(index))
      .forEach(markOccluded);
  }
  markClonedTree(out, source, covered);
}
