import { ActionableError } from "../../models/ActionableError";
import { findFocusedElement } from "../observe/HierarchyFocus";
import { hasOwnPrototype, scopeHierarchyToLayer } from "../observe/hierarchyLayer";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import { DefaultElementParser } from "../utility/ElementParser";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import type { FocusObserver } from "./FocusNavigate";

const parser = new DefaultElementParser();

/** `AccessibilityWindowInfo.TYPE_INPUT_METHOD`. */
const INPUT_METHOD_WINDOW_TYPE = 2;

/** Whether the capture lists an input-method window; undefined when it carries no window list. */
export function captureShowsIme(hierarchy: ViewHierarchyResult): boolean | undefined {
  const { windows } = hierarchy;
  if (!windows || windows.length === 0) {
    return undefined;
  }
  return windows.some((windowInfo) => windowInfo.type === INPUT_METHOD_WINDOW_TYPE);
}

/** A {@link FocusObserver} that reads a fresh hierarchy and its focused element. */
export function createFocusNavigateObserver(screen: Pick<ObserveScreen, "execute">): FocusObserver {
  return {
    read: async (signal) => {
      const result = await screen.execute({
        hierarchyOnly: true,
        skipScreenshot: true,
        skipCache: true,
        freshness: "fresh",
        signal,
      });
      if (!result.viewHierarchy) {
        throw new ActionableError(result.error ?? "The hierarchy read returned no view hierarchy");
      }
      let hierarchy = result.viewHierarchy;
      const imeVisible = captureShowsIme(hierarchy);
      let focused = result.focusedElement ?? findFocusedElement(hierarchy, parser);
      if (hasOwnPrototype(hierarchy)) {
        // App nodes can retain focus behind the overlay; prefer the prototype's own focus.
        const prototype = scopeHierarchyToLayer(hierarchy, "prototype");
        const prototypeFocus = findFocusedElement(prototype, parser);
        hierarchy = prototypeFocus ? prototype : scopeHierarchyToLayer(hierarchy, "app");
        focused = prototypeFocus ?? findFocusedElement(hierarchy, parser);
      }
      return {
        focused,
        elements: parser.flattenViewHierarchy(hierarchy).map(({ element }) => element),
        hierarchy,
        ...(imeVisible !== undefined ? { imeVisible } : {}),
      };
    },
  };
}
