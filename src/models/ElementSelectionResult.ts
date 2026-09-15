import type { Element } from "./Element";
import type { ElementSelectionStrategy } from "./ElementSelectionStrategy";
import type { ElementQueryResult } from "./ElementQuery";

/**
 * Result of selecting an element from a list of matches.
 */
export interface ElementSelectionResult {
  element: Element | null;
  indexInMatches: number;
  totalMatches: number;
  strategy: ElementSelectionStrategy;
  query?: ElementQueryResult;
}
