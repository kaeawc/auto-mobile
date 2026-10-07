import type { Element } from "../../models/Element";
import type { ViewHierarchyResult } from "../../models";

/** Locates the text input that currently owns input focus (IME key sessions, Keyboard). */
export interface FocusedInputQuery {
  findFocusedTextInput(viewHierarchy: any): any;
}

/** Enumerates scrollable containers (swipeOn auto-targeting, interaction identification). */
export interface ScrollableElementsQuery {
  findScrollableElements(viewHierarchy: ViewHierarchyResult): Element[];
}

/** Enumerates clickable elements (interaction identification). */
export interface ClickableElementsQuery {
  findClickableElements(viewHierarchy: ViewHierarchyResult): Element[];
}
