import type { Affordance, ElementBounds, ScreenSize } from "../../models";
import type { SearchableEntry } from "../utility/SearchableNode";
import { contains } from "./ApplicationWindowCover";

/**
 * Unnamed tap-only overflow artwork is chrome with multiple edges, or with one edge and an
 * enclosed sheet sibling or top-level popover content sibling.
 */
export function isIosPresentationChrome(
  node: {
    affordances: Iterable<Affordance>;
    label?: string;
    sublabel?: string;
    nativeId?: string;
    testTag?: string;
    bounds?: ElementBounds;
    className?: string;
    parentIndex?: number;
    index?: number;
  },
  screen: ScreenSize | undefined,
  nodes: readonly SearchableEntry[],
): boolean {
  // A zero-sized fallback is not evidence that artwork extends off screen.
  if (!screen || Math.min(screen.width, screen.height) <= 0 || !node.bounds) {
    return false;
  }
  const affordances = [...node.affordances];
  if (
    affordances.length !== 1 ||
    affordances[0] !== "tap" ||
    node.label !== undefined ||
    node.sublabel !== undefined ||
    node.nativeId !== undefined ||
    node.testTag !== undefined
  ) {
    return false;
  }
  const { left, top, right, bottom } = node.bounds;
  const overflowingEdges = [left < 0, top < 0, right > screen.width, bottom > screen.height].filter(
    Boolean,
  ).length;
  // List-anchored confirmation dialogs and edge-anchored popovers have a shadow halo
  // overflowing only one edge. Require the captured sheet or popover content sibling,
  // not just overlap with an action inside it.
  return (
    overflowingEdges >= 2 ||
    (overflowingEdges >= 1 && enclosesPresentationSibling(node, node.bounds, nodes))
  );
}

function enclosesPresentationSibling(
  node: Pick<SearchableEntry, "className" | "parentIndex"> & { index?: number },
  bounds: ElementBounds,
  nodes: readonly SearchableEntry[],
): boolean {
  return (
    containsSheetSibling(node, bounds, nodes) || containsPopoverContentSibling(node, bounds, nodes)
  );
}

function encloses(outer: ElementBounds, inner: ElementBounds): boolean {
  return (
    contains(outer, inner.left, inner.top) &&
    inner.right <= outer.right &&
    inner.bottom <= outer.bottom
  );
}

/**
 * A popover's shadow is a direct child of the presentation root (the application or a bare
 * root), drawn before the labeled content it surrounds. Artwork nested inside app content
 * never has the root as its parent, so an ordinary hero image under a caption is kept.
 */
function containsPopoverContentSibling(
  node: Pick<SearchableEntry, "className" | "parentIndex"> & { index?: number },
  bounds: ElementBounds,
  nodes: readonly SearchableEntry[],
): boolean {
  const { className, parentIndex, index } = node;
  if (className !== "UIImageView" || parentIndex === undefined || index === undefined) {
    return false;
  }
  const parent = nodes[parentIndex];
  if (
    parent?.index !== parentIndex ||
    (parent.parentIndex !== undefined && parent.className !== "XCUIApplication")
  ) {
    return false;
  }
  return nodes.some(
    (sibling) =>
      sibling.parentIndex === parentIndex &&
      sibling.index > index &&
      sibling.label !== undefined &&
      !!sibling.bounds &&
      encloses(bounds, sibling.bounds),
  );
}

function containsSheetSibling(
  node: Pick<SearchableEntry, "className" | "parentIndex"> & { index?: number },
  bounds: ElementBounds,
  nodes: readonly SearchableEntry[],
): boolean {
  const { className, parentIndex, index } = node;
  if (className !== "UIImageView" || parentIndex === undefined || index === undefined) {
    return false;
  }
  return nodes.some(
    (sibling) =>
      sibling.parentIndex === parentIndex &&
      sibling.index > index &&
      sibling.className === "UIActionSheet" &&
      !!sibling.bounds &&
      encloses(bounds, sibling.bounds),
  );
}
