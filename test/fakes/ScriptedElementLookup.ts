import type { Element } from "../../src/models/Element";
import type { ViewHierarchyResult } from "../../src/models";

/**
 * Scripted by-text and by-id lookups behind `FakeScrollElementResolver`. Scroll orchestration
 * tests replace these methods to script when the target appears; matcher behaviour is covered
 * against the real resolver.
 */
export class ScriptedElementLookup {
  nextElementByText: Element | null = null;
  nextElementByResourceId: Element | null = null;

  findElementByText(
    _viewHierarchy: ViewHierarchyResult,
    _text: string,
    _container?: { elementId?: string; text?: string } | null,
  ): Element | null {
    return this.nextElementByText;
  }

  findElementByResourceId(
    _viewHierarchy: ViewHierarchyResult,
    _resourceId: string,
    _container?: { elementId?: string; text?: string } | null,
  ): Element | null {
    return this.nextElementByResourceId;
  }
}
