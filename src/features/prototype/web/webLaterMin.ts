import {
  ARIA_HIDDEN,
  BORDER_BOX,
  BOX_SIZING,
  GRID_AREA,
  GRID_TEMPLATE_COLUMNS,
  JUSTIFY_SELF,
  MAX_WIDTH,
  MIN_WIDTH,
  STRETCH,
} from "./webCss";
import { el, type WebElement } from "./webNodes";
import type { Raw } from "../prototypeTemplate";
import { laterMinStrut, px, rowMinStrut, type WebStyleContext } from "./webStyle";

/**
 * CSS the row reads from its flex item: these move to the wrapping cell. Flex-container properties
 * (`flex-direction`, `flex-wrap`) stay on the node, which still lays out its own children.
 */
const ROW_FACING = /^(flex|flex-grow|flex-shrink|flex-basis|align-self|order|margin.*)$/;

/** Which minimum the strut cell holds (see withLaterMinStrut), if any. */
function strutMin(
  node: Raw,
  context: WebStyleContext,
): { readonly min: number; readonly capped: boolean } | undefined {
  const later = laterMinStrut(node.style, context);
  if (later !== undefined) {
    return { min: later, capped: false };
  }
  const row = rowMinStrut(node, context);
  return row === undefined ? undefined : { min: row, capped: true };
}

/**
 * A later sibling (see RowMeasure) with a content or `fill` width and an authored `minWidth`,
 * wrapped so its width is `max(content, minWidth)` while the row has room and still gives way to
 * zero before the capped aspect ratio does, as Android's `sizeIn` intersects the minimum with the
 * width left. Other elements are returned unchanged.
 *
 * The wrapper is the row's flex item (`min-width: 0`) and a one-cell grid whose `minmax(0, auto)`
 * column holds both the node and a zero-height strut `minWidth` wide. The column's content width is
 * therefore the larger of the two, yet its zero minimum lets it shrink. The node stretches across
 * the cell, so its own box shrinks with the row, and the strut's `max-width: 100%` keeps it from
 * overflowing the shrunk cell. Plain flex and grid, so every engine renders it alike, where
 * `calc-size()` is Chromium-only.
 *
 * A content-width row's own `minWidth` outside a row (see rowMinStrut) uses the same cell, capped
 * at the parent's width: its content width is still `max(content, minWidth)` in a wrap-sized
 * parent, and it never overflows a narrower one, as `sizeIn` coerces the minimum (#19373).
 */
export function withLaterMinStrut(
  element: WebElement,
  node: Raw,
  context: WebStyleContext,
): WebElement {
  const strut = strutMin(node, context);
  if (strut === undefined) {
    return element;
  }
  const { min, capped } = strut;
  const outer: Record<string, string> = {};
  const inner: Record<string, string> = {};
  for (const [key, value] of Object.entries(element.style)) {
    (ROW_FACING.test(key) ? outer : inner)[key] = value;
  }
  // A width here is a component default (an authored dp width never wraps): the node stretches
  // across the cell instead, as the folded minimum replaced that default before.
  delete inner.width;
  // An authored maximum also bounds the growing cell, so a `fill` width stops where it did.
  const authoredMax = element.style[MAX_WIDTH];
  if (capped) {
    outer[MAX_WIDTH] = authoredMax === undefined ? "100%" : `min(100%, ${authoredMax})`;
  } else if (authoredMax !== undefined) {
    outer[MAX_WIDTH] = authoredMax;
  }
  // Explicit: grid does not stretch an item with an aspect ratio or a replaced element by default.
  const cell = { [GRID_AREA]: "1 / 1", [MIN_WIDTH]: "0", [JUSTIFY_SELF]: STRETCH };
  const spacer = el("div", {
    attrs: { [ARIA_HIDDEN]: "true" },
    style: { [GRID_AREA]: "1 / 1", width: px(min), [MAX_WIDTH]: "100%", height: "0" },
  });
  return el(
    "div",
    {
      style: {
        ...outer,
        display: "grid",
        [GRID_TEMPLATE_COLUMNS]: "minmax(0, auto)",
        [MIN_WIDTH]: "0",
        [BOX_SIZING]: BORDER_BOX,
      },
    },
    [{ ...element, style: { ...inner, ...cell } }, spacer],
  );
}
