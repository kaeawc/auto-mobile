import type { Element } from "./Element";
import type { ElementSelectionStrategy } from "./ElementSelectionStrategy";

/**
 * Result of selecting an element from a list of matches.
 */
export interface ElementSelectionResult {
  element: Element | null;
  /** Original matching node, before action-target promotion. */
  matchedElement?: Element;
  captureId?: string;
  /**
   * No element was selected, but the selector's only match is a soft-keyboard key,
   * which `observe` folds into one `<ime>` row and a text selector never targets
   * (issue #10225).
   */
  onlyKeyboardKeyMatch?: boolean;
  indexInMatches: number;
  totalMatches: number;
  strategy: ElementSelectionStrategy;
}
