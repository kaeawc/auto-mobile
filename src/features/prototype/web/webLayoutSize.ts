import { cssLength, type CssVars } from "./webCssLength";
import type { WebElement } from "./webNodes";

/**
 * A length in the still's layout pass (#16667): px, or undefined when it depends on content the
 * pass does not measure (text, an unsized element). An unknown offset or height is taken as
 * positive, since content that paints takes room; an unknown width covers nothing it can name.
 */
export type Len = number | undefined;

/** An element's border box on the screen, in px from the screen's top-left corner. */
export interface WebRect {
  readonly left: Len;
  readonly top: Len;
  readonly width: Len;
  readonly height: Len;
}

export type Axis = "width" | "height";

export const add = (a: Len, b: Len): Len =>
  a === undefined || b === undefined ? undefined : a + b;
export const sub = (a: Len, b: Len): Len =>
  a === undefined || b === undefined ? undefined : a - b;

/** A declared size: px, unknown (a percentage of an unknown size), or `auto` (content-sized). */
export function declaredSize(
  element: WebElement,
  axis: Axis,
  base: Len,
  vars: CssVars,
): Len | "auto" {
  const value = element.style[axis];
  if (value === undefined || value === "auto" || /content/.test(value)) {
    return "auto";
  }
  return cssLength(value, vars, base);
}

/**
 * A size clamped by the element's `min-*` and `max-*` (the minimum wins, as in CSS). An unknown
 * (content) size is taken at its minimum when one is set.
 */
export function clampSize(
  size: Len,
  element: WebElement,
  axis: Axis,
  context: { readonly base: Len; readonly vars: CssVars },
): Len {
  const min = cssLength(element.style[`min-${axis}`], context.vars, context.base);
  const max = cssLength(element.style[`max-${axis}`], context.vars, context.base);
  if (size === undefined) {
    return min !== undefined && min > 0 ? min : undefined;
  }
  return Math.max(min ?? -Infinity, Math.min(max ?? Infinity, size));
}

const START = new Set<string | undefined>([
  undefined,
  "start",
  "flex-start",
  "self-start",
  "left",
  "top",
  "normal",
  "stretch",
  "baseline",
]);
const END = new Set<string | undefined>(["end", "flex-end", "self-end", "right", "bottom"]);

/** Where an item of `size` sits in `available` room under a self-alignment value. */
export function alignOffset(align: string | undefined, available: Len, size: Len): Len {
  if (START.has(align)) {
    return 0;
  }
  const free = sub(available, size);
  if (free === undefined) {
    // Content smaller than its room leaves a gap before a centred or end-aligned item.
    return undefined;
  }
  if (END.has(align)) {
    return free;
  }
  return align === "center" ? free / 2 : 0;
}

/** Splits a shorthand into its top-level space-separated values, keeping `calc(a + b)` whole. */
export function shorthandValues(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const values: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value.trim()) {
    depth += char === "(" ? 1 : char === ")" ? -1 : 0;
    if (/\s/.test(char) && depth === 0) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  return [...values, current].filter((part) => part !== "");
}

/** A 1-4 value box shorthand as [top, right, bottom, left]. */
export function boxSides(value: string | undefined): (string | undefined)[] {
  const [top, right = top, bottom = top, left = right] = shorthandValues(value);
  return [top, right, bottom, left];
}

export interface Insets {
  readonly top: Len;
  readonly right: Len;
  readonly bottom: Len;
  readonly left: Len;
}

const PADDING: readonly (readonly [keyof Insets, readonly string[]])[] = [
  ["top", ["padding-top", "padding-block-start"]],
  ["right", ["padding-right", "padding-inline-end"]],
  ["bottom", ["padding-bottom", "padding-block-end"]],
  ["left", ["padding-left", "padding-inline-start"]],
];

/** A border's width: the `border` shorthand's length, if it has one. */
function borderWidth(element: WebElement, vars: CssVars): number {
  const width = shorthandValues(element.style.border)
    .map((part) => cssLength(part, vars))
    .find((value) => value !== undefined);
  return width ?? 0;
}

/**
 * The room padding and border take on each side; percentages read the containing width. An
 * unresolved side is unknown.
 */
export function contentInsets(element: WebElement, base: Len, vars: CssVars): Insets {
  const shorthand = boxSides(element.style.padding);
  const border = borderWidth(element, vars);
  const side = (index: number, names: readonly string[]): Len => {
    const longhand = names.map((name) => element.style[name]).find((value) => value !== undefined);
    const value = longhand ?? shorthand[index] ?? "0";
    return add(cssLength(value, vars, base), border);
  };
  const [top, right, bottom, left] = PADDING.map(([, names], index) => side(index, names));
  return { top, right, bottom, left };
}

/** The box children are laid out in: the rect less padding and border. */
export function contentBox(element: WebElement, rect: WebRect, vars: CssVars): WebRect {
  const insets = contentInsets(element, rect.width, vars);
  return {
    left: add(rect.left, insets.left),
    top: add(rect.top, insets.top),
    width: sub(sub(rect.width, insets.left), insets.right),
    height: sub(sub(rect.height, insets.top), insets.bottom),
  };
}

/** Fills the unknown dimension from the known one by the element's `aspect-ratio`. */
export function withAspectRatio(element: WebElement, rect: WebRect): WebRect {
  const [width, height = "1"] = (element.style["aspect-ratio"] ?? "").split("/");
  const ratio = Number(width) / Number(height);
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return rect;
  }
  if (rect.height === undefined && rect.width !== undefined) {
    return { ...rect, height: rect.width / ratio };
  }
  if (rect.width === undefined && rect.height !== undefined) {
    return { ...rect, width: rect.height * ratio };
  }
  return rect;
}
