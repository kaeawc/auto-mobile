import type { Element } from "../../src/models/Element";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../src/models";
import type { ElementFinder } from "../../src/utils/interfaces/ElementFinder";

export class FakeElementFinder implements ElementFinder {
  nextElementByText: Element | null = null;
  nextElementByResourceId: Element | null = null;
  nextContainerNode: ViewHierarchyNode | null = null;
  nextHasContainer: boolean = false;

  lastFindByTextArgs?: {
    text: string;
    container?: any;
    partialMatch?: boolean;
    caseSensitive?: boolean;
  };
  lastFindByResourceIdArgs?: { resourceId: string; container?: any; partialMatch?: boolean };

  findElementByText(
    _viewHierarchy: ViewHierarchyResult,
    text: string,
    container?: { elementId?: string; text?: string } | null,
    partialMatch?: boolean,
    caseSensitive?: boolean,
  ): Element | null {
    this.lastFindByTextArgs = { text, container, partialMatch, caseSensitive };
    return this.nextElementByText;
  }

  findElementByResourceId(
    _viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    container?: { elementId?: string; text?: string } | null,
    partialMatch?: boolean,
  ): Element | null {
    this.lastFindByResourceIdArgs = { resourceId, container, partialMatch };
    return this.nextElementByResourceId;
  }

  findContainerNode(
    _viewHierarchy: ViewHierarchyResult,
    _container: { elementId?: string; text?: string },
  ): ViewHierarchyNode | null {
    return this.nextContainerNode;
  }

  hasContainerElement(
    _viewHierarchy: ViewHierarchyResult,
    _container?: { elementId?: string; text?: string },
  ): boolean {
    return this.nextHasContainer;
  }
}
