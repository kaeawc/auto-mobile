import type { Affordance, ElementBounds, ScreenSize } from "../../models";
import type { SearchableEntry } from "../utility/SearchableNode";
import { contains } from "./ApplicationWindowCover";

/** Unnamed tap-only overflow artwork is chrome with multiple edges or an enclosed sheet sibling. */
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
  // List-anchored confirmation dialogs have a shadow halo overflowing only one edge.
  // Require the captured sheet sibling, not just overlap with an action inside it.
  return (
    overflowingEdges >= 2 ||
    (overflowingEdges >= 1 && containsSheetSibling(node, node.bounds, nodes))
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
      contains(bounds, sibling.bounds.left, sibling.bounds.top) &&
      sibling.bounds.right <= bounds.right &&
      sibling.bounds.bottom <= bounds.bottom,
  );
}
