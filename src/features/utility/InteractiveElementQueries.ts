import type { Element } from "../../models/Element";
import type { ViewHierarchyResult } from "../../models";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { ClickableElementsQuery } from "../../utils/interfaces/ElementTraitQueries";
import { DefaultElementParser } from "./ElementParser";
import { isClickableElementProperties } from "./elementProperties";
import { collectMatchingElements } from "./DefaultScrollableElementsQuery";
export { DefaultScrollableElementsQuery } from "./DefaultScrollableElementsQuery";

/** Enumerates clickable elements for interaction identification. */
export class DefaultClickableElementsQuery implements ClickableElementsQuery {
  constructor(private readonly parser: ElementParser = new DefaultElementParser()) {}

  findClickableElements(viewHierarchy: ViewHierarchyResult | null): Element[] {
    return collectMatchingElements(this.parser, viewHierarchy, isClickableElementProperties);
  }
}
