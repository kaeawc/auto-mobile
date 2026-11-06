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
const FOCUS_OUTLINE = { outline: "3px solid #ffffff", "outline-offset": "2px" } as const;
const FOCUS_SHADOW = "0 0 0 5px rgba(0, 0, 0, 0.6)";

/**
 * A focusable role on a spec node or on a part drawn inside one: `tabBar` and `bottomNav` items and
 * a dialog's action buttons carry the role without a node annotation of their own. A role outside
 * every spec node (page chrome) never takes focus.
 */
function isFocusable(element: WebElement, inSpec: boolean): boolean {
  return (
    (inSpec || element.attrs["data-node"] !== undefined) &&
    FOCUSABLE_ROLES.has(element.attrs.role ?? "")
  );
}

/** An open dialog's layer; on both platforms a modal dialog takes focus from the screen below. */
const isModalLayer = (element: WebElement): boolean => element.attrs["data-part"] === "dialogLayer";

/** Child indices from the root to the last modal layer in document order, if any is open. */
function lastModalPath(element: WebElement): number[] | undefined {
  let found: number[] | undefined;
  element.children.forEach((child, index) => {
    if (typeof child === "string") {
      return;
    }
    const below = lastModalPath(child);
    if (below) {
      found = [index, ...below];
    } else if (isModalLayer(child)) {
      found = [index];
    }
  });
  return found;
}

function marked(element: WebElement): WebElement {
  return {
    ...element,
    attrs: { ...element.attrs, "data-focus": "ring" },
    style: {
      ...element.style,
      ...FOCUS_OUTLINE,
      // Added to the node's own shadows (a selected tab's inset underline, an authored elevation).
      "box-shadow": element.style["box-shadow"]
        ? `${FOCUS_SHADOW}, ${element.style["box-shadow"]}`
        : FOCUS_SHADOW,
    },
  };
}

/** Depth-first, document order; `found` flips once the first focusable node is marked. */
function walk(child: WebChild, state: { found: boolean }, inSpec = false): WebChild {
  // A disabled control's parts (an iOS field's inner input) are disabled with it.
  if (typeof child === "string" || state.found || child.attrs["aria-disabled"] === "true") {
    return child;
  }
  if (isFocusable(child, inSpec)) {
    state.found = true;
    return marked(child);
  }
  const spec = inSpec || child.attrs["data-node"] !== undefined;
  const children = child.children.map((grandchild) => walk(grandchild, state, spec));
  return state.found ? { ...child, children } : child;
}

/** Marks within the element at `path`, rebuilding only the elements along it. */
function walkAt(
  element: WebElement,
  path: readonly number[],
  state: { found: boolean },
): WebElement {
  const [index, ...rest] = path;
  if (index === undefined) {
    return walk(element, state) as WebElement;
  }
  const target = element.children[index] as WebElement;
  const replaced = walkAt(target, rest, state);
  return replaced === target
    ? element
    : { ...element, children: element.children.map((c, i) => (i === index ? replaced : c)) };
}

/**
 * Marks the first focusable spec node in document order with a focus ring (`data-focus="ring"`),
 * as a TV draws its initial focus; a 10-foot UI with no focus is not a usable preview. With a
 * dialog open, focus starts inside the last one. A tree with no focusable node comes back unchanged.
 */
export function markInitialFocus(content: WebElement): WebElement {
  return walkAt(content, lastModalPath(content) ?? [], { found: false });
}
