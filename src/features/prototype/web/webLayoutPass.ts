import { cssLength, type CssVars } from "./webCssLength";
import { borderRadii, inCutCorner, type CornerRadii, type RoundedRect } from "./webLayoutCorners";
import { outOfFlow, placeInFlow, type PlacedChild } from "./webLayoutLine";
import {
  add,
  boxSides,
  clampSize,
  contentBox,
  declaredSize,
  sub,
  withAspectRatio,
  type Axis,
  type Len,
  type WebRect,
} from "./webLayoutSize";
import type { WebElement } from "./webNodes";

/**
 * A small layout pass over the still's element tree (#16667): each element's border box on the
 * screen, from the CSS the renderer emits (flex lines, one-cell boxes, block flow, absolute
 * placement, translation), so a question about what paints where is answered by geometry.
 */

export type { WebRect } from "./webLayoutSize";
export type { CornerRadii, RoundedRect } from "./webLayoutCorners";

/** The screen the content fills, in px. */
export interface WebScreenSize {
  readonly width: number;
  readonly height: number;
}

/**
 * An element as it paints: its border box and corner radii, its composite opacity and the clips
 * around it.
 */
export interface PaintedBox {
  readonly element: WebElement;
  readonly rect: WebRect;
  /** The radii that round the border box; undefined when every corner is square. */
  readonly radii?: CornerRadii;
  /** The element's opacity times every ancestor's. */
  readonly opacity: number;
  /** The rounded border boxes of the overflow-clipping ancestors; only their intersection shows. */
  readonly clips: readonly RoundedRect[];
}

const MAX_DEPTH = 64;

/** The element's own `opacity` (1 when unset or unparseable). */
function ownOpacity(element: WebElement): number {
  const value = Number(element.style.opacity);
  return element.style.opacity === undefined || !Number.isFinite(value) ? 1 : value;
}

/** The custom properties in scope for an element: its ancestors', then its own. */
function scopedVars(element: WebElement, inherited: CssVars): CssVars {
  const own = Object.entries(element.style).filter(([name]) => name.startsWith("--"));
  return own.length === 0 ? inherited : { ...inherited, ...Object.fromEntries(own) };
}

const TRANSLATE = /^translate(X|Y|3d)?\(([^()]*)\)$/;

/** A `translate`, `translateX`, `translateY` or `translate3d` shift; undefined for any other transform. */
function translation(element: WebElement, rect: WebRect, vars: CssVars): [Len, Len] | undefined {
  const transform = element.style.transform?.trim();
  if (transform === undefined || transform === "none") {
    return [0, 0];
  }
  const match = TRANSLATE.exec(transform);
  if (!match) {
    return undefined;
  }
  const args = match[2]!.split(",").map((part) => part.trim());
  const x = match[1] === "Y" ? "0" : args[0];
  const y = match[1] === "Y" ? args[0] : match[1] === "X" ? "0" : (args[1] ?? "0");
  return [cssLength(x, vars, rect.width), cssLength(y, vars, rect.height)];
}

/** A relatively positioned element's shift by its `top`/`bottom` and `left`/`right`. */
function relativeShift(element: WebElement, rect: WebRect, vars: CssVars): [Len, Len] {
  if (element.style.position !== "relative") {
    return [0, 0];
  }
  const shift = (start: string, end: string, base: Len): Len => {
    const { style } = element;
    if (style[start] !== undefined && style[start] !== "auto") {
      return cssLength(style[start], vars, base);
    }
    const back =
      style[end] === undefined || style[end] === "auto" ? 0 : cssLength(style[end], vars, base);
    return back === undefined ? undefined : -back;
  };
  return [shift("left", "right", rect.width), shift("top", "bottom", rect.height)];
}

/** The rect after relative positioning and translation; any other transform leaves it unknown. */
function moved(element: WebElement, rect: WebRect, vars: CssVars): WebRect {
  const translate = translation(element, rect, vars);
  if (!translate) {
    return { ...rect, left: undefined, top: undefined };
  }
  const [dx, dy] = relativeShift(element, rect, vars);
  return {
    ...rect,
    left: add(add(rect.left, dx), translate[0]),
    top: add(add(rect.top, dy), translate[1]),
  };
}

const present = (value: string | undefined): value is string =>
  value !== undefined && value !== "auto";

/** An absolute child's start and end insets on one axis, from the longhands or `inset`. */
function insetsOn(child: WebElement, axis: Axis): [string | undefined, string | undefined] {
  const [top, right, bottom, left] = boxSides(child.style.inset);
  const { style } = child;
  return axis === "width"
    ? [style.left ?? left, style.right ?? right]
    : [style.top ?? top, style.bottom ?? bottom];
}

/** An absolute child's size on one axis: declared, else stretched between both insets. */
function absoluteSize(child: WebElement, axis: Axis, container: WebRect, vars: CssVars): Len {
  const [startValue, endValue] = insetsOn(child, axis);
  const room = container[axis];
  const declared = declaredSize(child, axis, room, vars);
  const stretched =
    present(startValue) && present(endValue)
      ? sub(sub(room, cssLength(startValue, vars, room)), cssLength(endValue, vars, room))
      : undefined;
  return clampSize(declared === "auto" ? stretched : declared, child, axis, { base: room, vars });
}

/** An absolute child's start on one axis, against its container's border box. */
function absoluteStart(
  child: WebElement,
  axis: Axis,
  container: WebRect,
  context: { readonly size: Len; readonly vars: CssVars },
): Len {
  const [startValue, endValue] = insetsOn(child, axis);
  const room = container[axis];
  const origin = axis === "width" ? container.left : container.top;
  if (present(startValue)) {
    return add(origin, cssLength(startValue, context.vars, room));
  }
  // Only an end offset: measure back from the far edge. Neither: the static position, its start.
  return present(endValue)
    ? sub(add(origin, sub(room, cssLength(endValue, context.vars, room))), context.size)
    : origin;
}

function absoluteChild(child: WebElement, container: WebRect, vars: CssVars): PlacedChild {
  // A ratio-derived dimension is known before an end inset places the child.
  const { width, height } = withAspectRatio(
    child,
    {
      left: 0,
      top: 0,
      width: absoluteSize(child, "width", container, vars),
      height: absoluteSize(child, "height", container, vars),
    },
    container,
    vars,
  );
  const left = absoluteStart(child, "width", container, { size: width, vars });
  const top = absoluteStart(child, "height", container, { size: height, vars });
  return { element: child, rect: { left, top, width, height } };
}

/**
 * CSS paint order among siblings: a negative z-index first, then the in-flow children, then the
 * positioned ones; ties keep tree order.
 */
function paintLayer(child: WebElement): number {
  const z = Number(child.style["z-index"]);
  const positioned = child.style.position !== undefined && child.style.position !== "static";
  const layer = Number.isFinite(z) && child.style["z-index"] !== undefined ? z : 0;
  return layer < 0 ? layer : layer + (positioned ? 0.5 : 0);
}

function childrenInPaintOrder(element: WebElement, rect: WebRect, vars: CssVars): PlacedChild[] {
  const elements = element.children.filter(
    (child): child is WebElement => typeof child !== "string",
  );
  const placed = new Map<WebElement, WebRect>(
    [
      ...placeInFlow(element, contentBox(element, rect, vars), vars),
      ...elements.filter(outOfFlow).map((child) => absoluteChild(child, rect, vars)),
    ].map((entry) => [entry.element, entry.rect]),
  );
  return elements
    .flatMap((child, index) => {
      const childRect = placed.get(child);
      return childRect
        ? [{ element: child, rect: childRect, index, layer: paintLayer(child) }]
        : [];
    })
    .sort((a, b) => a.layer - b.layer || a.index - b.index)
    .map(({ element: child, rect: childRect }) => ({ element: child, rect: childRect }));
}

const clipsOverflow = (element: WebElement): boolean =>
  ["overflow", "overflow-x", "overflow-y"].some((name) => {
    const value = element.style[name];
    return value !== undefined && value !== "visible";
  });

/**
 * Whether anything inside a box can still reach the screen's top edge: its place is known, and it
 * starts at the top or lets its children overflow (an alignment or offset can carry one upward).
 */
const mayReachTop = (element: WebElement, rect: WebRect): boolean =>
  rect.left !== undefined && rect.top !== undefined && (rect.top <= 0 || !clipsOverflow(element));

interface PaintStep {
  readonly rect: WebRect;
  readonly opacity: number;
  readonly vars: CssVars;
  readonly clips: readonly RoundedRect[];
  /** Whether the element's inherited direction is right to left. */
  readonly rtl: boolean;
  readonly depth: number;
}

/** An element's direction: its own `dir` or `direction`, else its parent's. */
function isRtl(element: WebElement, inherited: boolean): boolean {
  const own = element.attrs.dir ?? element.style.direction;
  return own === "rtl" ? true : own === "ltr" ? false : inherited;
}

function paintElement(element: WebElement, step: PaintStep, painted: PaintedBox[]): void {
  const opacity = step.opacity * ownOpacity(element);
  if (opacity <= 0 || element.style.display === "none") {
    // Nothing in a fully transparent or undisplayed subtree paints.
    return;
  }
  const vars = scopedVars(element, step.vars);
  const rect = moved(element, step.rect, vars);
  const rtl = isRtl(element, step.rtl);
  const radii = borderRadii(element, rect, vars, rtl);
  painted.push({ element, rect, radii, opacity, clips: step.clips });
  // A clipped subtree below the top edge, or one at an unknown place, cannot cover it.
  if (step.depth >= MAX_DEPTH || !mayReachTop(element, rect)) {
    return;
  }
  const clips = clipsOverflow(element) ? [...step.clips, { rect, radii }] : step.clips;
  for (const child of childrenInPaintOrder(element, rect, vars)) {
    const next = { rect: child.rect, opacity, vars, clips, rtl, depth: step.depth + 1 };
    paintElement(child.element, next, painted);
  }
}

/**
 * The elements that can paint at the screen's top edge, in paint order (later paints over
 * earlier), with their geometry. `root` fills the screen; `vars` are the custom properties the
 * screen defines (the safe-area insets). A subtree that starts below the top edge, or at a place
 * the pass cannot compute, is not descended into.
 */
export function topEdgePaintOrder(
  root: WebElement,
  screen: WebScreenSize,
  vars: CssVars = {},
): PaintedBox[] {
  const painted: PaintedBox[] = [];
  const rect = { left: 0, top: 0, width: screen.width, height: screen.height };
  paintElement(root, { rect, opacity: 1, vars, clips: [], rtl: false, depth: 0 }, painted);
  return painted;
}

/**
 * Whether a rounded rect covers the point `x` on the screen's top edge (y = 0): inside the rect
 * and outside the region each rounded corner cuts away.
 */
function coversTopEdge({ rect, radii }: RoundedRect, x: number): boolean {
  const { left, top, width, height } = rect;
  if (left === undefined || top === undefined || width === undefined) {
    return false;
  }
  // An unmeasured height is taken as positive: content that paints takes room.
  const inRect =
    left <= x && x < left + width && top <= 0 && (height === undefined || top + height > 0);
  return inRect && (radii === undefined || !inCutCorner(radii, { left, top, width, height }, x, 0));
}

/** Whether a painted box shows at `x` on the top edge: inside its own shape and every clip. */
export function paintsTopEdgeAt(box: PaintedBox, x: number): boolean {
  return coversTopEdge(box, x) && box.clips.every((clip) => coversTopEdge(clip, x));
}
