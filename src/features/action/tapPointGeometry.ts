// Pure tap-point geometry helpers moved out of TapOnElement (#11833); behaviour unchanged.

import type { Element, ElementSelectionResult } from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";

export function matchedTapElement(
  selection: ElementSelectionResult,
  target: Element,
  options?: TapOnElementOptions,
): Element {
  // Sibling selectors act on a different node from their anchor; focus
  // selectors may similarly promote a label to its editable field.
  return options?.sibling || options?.action === "focus"
    ? target
    : (selection.matchedElement ?? target);
}
