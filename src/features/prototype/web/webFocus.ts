import type { WebChild, WebElement } from "./webNodes";

/** The roles a d-pad can land on; a rendered spec node carrying one of these is focusable. */
const FOCUSABLE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "switch",
  "slider",
  "tab",
  "textbox",
]);

/**
 * Drawn as an outline, so it neither moves nor resizes the node. Leanback and tvOS both mark the
 * focused item with a light border; one generic ring stands in for either.
 */
const FOCUS_RING = {
  outline: "3px solid #ffffff",
  "outline-offset": "2px",
  "box-shadow": "0 0 0 5px rgba(0, 0, 0, 0.6)",
} as const;

/**
 * A spec node with a focusable role, or an item of a spec node's tab list: `tabBar` and
 * `bottomNav` draw their items as `role="tab"` children without a node annotation of their own.
 */
function isFocusable(element: WebElement, inTablist: boolean): boolean {
  const role = element.attrs.role ?? "";
  const target =
    element.attrs["data-node"] !== undefined
      ? FOCUSABLE_ROLES.has(role)
      : inTablist && role === "tab";
  return target && element.attrs["aria-disabled"] !== "true";
}

function isSpecTablist(element: WebElement): boolean {
  return element.attrs["data-node"] !== undefined && element.attrs.role === "tablist";
}

function marked(element: WebElement): WebElement {
  return {
    ...element,
    attrs: { ...element.attrs, "data-focus": "ring" },
    style: { ...element.style, ...FOCUS_RING },
  };
}

/** Depth-first, document order; `found` flips once the first focusable node is marked. */
function walk(child: WebChild, state: { found: boolean }, inTablist = false): WebChild {
  if (typeof child === "string" || state.found) {
    return child;
  }
  if (isFocusable(child, inTablist)) {
    state.found = true;
    return marked(child);
  }
  const tablist = inTablist || isSpecTablist(child);
  const children = child.children.map((grandchild) => walk(grandchild, state, tablist));
  return state.found ? { ...child, children } : child;
}

/**
 * Marks the first focusable spec node in document order with a focus ring (`data-focus="ring"`),
 * as a TV draws its initial focus; a 10-foot UI with no focus is not a usable preview. A tree with
 * no focusable node comes back unchanged.
 */
export function markInitialFocus(content: WebElement): WebElement {
  return walk(content, { found: false }) as WebElement;
}
