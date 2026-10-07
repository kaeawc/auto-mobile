import type { Element } from "../../src/models/Element";
import type { ViewHierarchyResult } from "../../src/models";
import type { ScrollableElementsQuery } from "../../src/utils/interfaces/ElementTraitQueries";

/** Returns `nextScrollableElements` for every hierarchy. */
export class FakeScrollableElementsQuery implements ScrollableElementsQuery {
  nextScrollableElements: Element[] = [];

  findScrollableElements(_viewHierarchy: ViewHierarchyResult): Element[] {
    return this.nextScrollableElements;
  }
}
