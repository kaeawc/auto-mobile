import type { Element, ViewHierarchyResult } from "../../models";
import { filterUnexhaustedElements } from "./ExploreElementExtraction";
import { selectBreadthFirst, selectDepthFirst, selectWeighted } from "./ExploreElementScoring";
import type {
  ElementSelectionStats,
  ExplorationMode,
  ExplorationStrategy,
  TrackedElement,
} from "./ExploreTypes";
interface DiscoverySelectionContext {
  currentScreen: string | null;
  exploredElements: Map<string, TrackedElement>;
  elementSelections: ElementSelectionStats[];
}
/** Choose an unexhausted discovery candidate and record weighted-selection statistics. */
export function selectDiscoveryElement(
  candidates: { elements: Element[]; hierarchy: ViewHierarchyResult },
  strategy: ExplorationStrategy,
  mode: ExplorationMode,
  context: DiscoverySelectionContext,
): Element | null {
  const safeCandidates = candidates.elements;
  const viewHierarchy = candidates.hierarchy;
  // Filter out exhausted elements
  const currentScreen = context.currentScreen;
  const unexhaustedElements = filterUnexhaustedElements(
    safeCandidates,
    context.exploredElements,
    currentScreen,
    viewHierarchy,
  );

  if (unexhaustedElements.length === 0) {
    return null;
  }

  // Select based on strategy
  switch (strategy) {
    case "breadth-first":
      return selectBreadthFirst(unexhaustedElements);
    case "depth-first":
      return selectDepthFirst(unexhaustedElements, context.exploredElements);
    case "weighted":
    default: {
      const result = selectWeighted(unexhaustedElements, mode, context.exploredElements);
      if (result) {
        // Record selection stats
        context.elementSelections.push(result.stats);
        return result.element;
      }
      return null;
    }
  }
}
