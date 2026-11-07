import { cssLength, type CssVars } from "./webCssLength";
import {
  add,
  alignOffset,
  clampSize,
  contentInsets,
  declaredSize,
  shorthandValues,
  sub,
  withAspectRatio,
  type Axis,
  type Len,
  type WebRect,
} from "./webLayoutSize";
import type { WebChild, WebElement } from "./webNodes";

/** A child element and the border box its container's layout gives it. */
export interface PlacedChild {
  readonly element: WebElement;
  readonly rect: WebRect;
}

/**
 * How a container lays out its children: a box (`boxLayoutCss`, any grid here) stacks them in one
 * cell; a flex line places them along its axis; anything else flows them as blocks.
 */
type Layout = "box" | "tracks" | "row" | "column" | "flow";

/** A collection grid's column count, from its `repeat(N, ...)` template. */
function trackCount(element: WebElement): number | undefined {
  const match = /^repeat\(\s*(\d+)\s*,/.exec(element.style["grid-template-columns"]?.trim() ?? "");
  return match ? Number(match[1]) : undefined;
}

function layoutOf(element: WebElement): Layout {
  const { display } = element.style;
  if (display === "grid" || display === "inline-grid") {
    // A collection grid lays cells out row-major in its column tracks; any other grid is a box.
    return trackCount(element) === undefined ? "box" : "tracks";
  }
  if (display === "flex" || display === "inline-flex") {
    return element.style["flex-direction"]?.startsWith("column") ? "column" : "row";
  }
  return "flow";
}

/** Whether a child leaves the flow (absolute or fixed) and is placed against its container. */
export const outOfFlow = (child: WebElement): boolean =>
  child.style.position === "absolute" || child.style.position === "fixed";

/** What placing a container's children needs: the container, its content box and variables. */
interface Container {
  readonly parent: WebElement;
  readonly content: WebRect;
  readonly vars: CssVars;
}

const crossOf = (axis: Axis): Axis => (axis === "width" ? "height" : "width");

/** A rect from a main-axis and cross-axis position and size. */
function oriented(main: Axis, position: [Len, Len], size: [Len, Len]): WebRect {
  return main === "width"
    ? { left: position[0], top: position[1], width: size[0], height: size[1] }
    : { left: position[1], top: position[0], width: size[1], height: size[0] };
}

const startOf = (rect: WebRect, axis: Axis): Len => (axis === "width" ? rect.left : rect.top);

/**
 * A child's size on one axis where self-alignment can stretch it: declared, else the room when
 * stretched, else content-sized. A missing alignment is the renderer's start, never CSS's stretch.
 */
function alignedSize(
  child: WebElement,
  axis: Axis,
  align: string | undefined,
  box: Container,
): Len {
  const room = box.content[axis];
  const declared = declaredSize(child, axis, room, box.vars);
  const stretched = align === "stretch" || align === "normal";
  const size =
    declared !== "auto" ? declared : stretched ? room : measuredContent(child, axis, box.vars, 0);
  return clampSize(size, child, axis, { base: room, vars: box.vars });
}

const MAX_MEASURE_DEPTH = 32;

/** An element's size on one axis with no room to resolve against: declared, else measured. */
function measuredSize(element: WebElement, axis: Axis, vars: CssVars, depth: number): Len {
  const declared = declaredSize(element, axis, undefined, vars);
  const size = declared === "auto" ? measuredContent(element, axis, vars, depth) : declared;
  return clampSize(size, element, axis, { base: undefined, vars });
}

/**
 * The in-flow children a content-sized element can be measured from; undefined when any is text,
 * inline in flow or has a margin, or when there are none or they lie in tracks.
 */
function measurableChildren(element: WebElement, layout: Layout): WebElement[] | undefined {
  const children = element.children.filter((child) =>
    typeof child !== "string"
      ? !outOfFlow(child) && child.style.display !== "none"
      : child.trim() !== "",
  );
  const elements = elementsOf(children);
  const unmeasurable =
    layout === "tracks" ||
    elements.length === 0 ||
    elements.length < children.length ||
    elements.some(
      (child) =>
        (layout === "flow" && isInline(child)) ||
        Object.keys(child.style).some((name) => name.startsWith("margin")),
    );
  return unmeasurable ? undefined : elements;
}

/**
 * A content-sized element's size on one axis from its measurable in-flow children (#17459):
 * stacked along its layout's axis with its gap, else the largest, plus padding and border.
 * Unknown when any child is unmeasurable.
 */
function measuredContent(element: WebElement, axis: Axis, vars: CssVars, depth: number): Len {
  const layout = layoutOf(element);
  const elements = depth >= MAX_MEASURE_DEPTH ? undefined : measurableChildren(element, layout);
  const sizes = (elements ?? []).map((child) => measuredSize(child, axis, vars, depth + 1));
  const known = sizes.filter((size): size is number => size !== undefined);
  if (elements === undefined || known.length < sizes.length) {
    return undefined;
  }
  const stacked =
    layout === (axis === "width" ? "row" : "column") || (layout === "flow" && axis === "height");
  const unknownRoom: WebRect = { left: 0, top: 0, width: undefined, height: undefined };
  const gap =
    layout === "flow" ? 0 : mainGap(axis, { parent: element, content: unknownRoom, vars });
  const extent = stacked
    ? known.reduce((sum, size) => sum + size, gap * (known.length - 1))
    : Math.max(...known);
  const insets = contentInsets(element, undefined, vars);
  return axis === "width"
    ? add(add(extent, insets.left), insets.right)
    : add(add(extent, insets.top), insets.bottom);
}

/** A cell's column span, from `grid-column: span N`. */
function columnSpan(child: WebElement, columns: number): number {
  const span = Number(/^span\s+(\d+)$/.exec(child.style["grid-column"]?.trim() ?? "")?.[1] ?? 1);
  return Math.min(Math.max(1, span), columns);
}

/**
 * A collection grid: equal column tracks, cells packed row-major, each starting a new row when it
 * no longer fits. Rows after the first start below the first row's unmeasured height.
 */
function placeTracks(
  children: readonly WebElement[],
  columns: number,
  box: Container,
): PlacedChild[] {
  const { content, vars } = box;
  const [rowGap, columnGap = rowGap] = shorthandValues(box.parent.style.gap);
  const gap = cssLength(box.parent.style["column-gap"] ?? columnGap, vars, content.width) ?? 0;
  const track =
    content.width === undefined ? undefined : (content.width - gap * (columns - 1)) / columns;
  const placed: PlacedChild[] = [];
  let column = 0;
  let row = 0;
  for (const child of children) {
    const span = columnSpan(child, columns);
    if (column + span > columns) {
      column = 0;
      row += 1;
    }
    const left = track === undefined ? undefined : add(content.left, column * (track + gap));
    const width = track === undefined ? undefined : span * track + (span - 1) * gap;
    const cell: Container = {
      ...box,
      content: { left, top: row === 0 ? content.top : undefined, width, height: undefined },
    };
    placed.push(placeInCell(child, cell));
    column += span;
  }
  return placed;
}

/** A box child: sized and aligned on each axis by its self-alignment in the one cell. */
function placeInCell(child: WebElement, box: Container): PlacedChild {
  const justify = child.style["justify-self"] ?? box.parent.style["justify-items"];
  const align = child.style["align-self"] ?? box.parent.style["align-items"];
  const sized = withAspectRatio(child, {
    left: 0,
    top: 0,
    width: alignedSize(child, "width", justify, box),
    height: alignedSize(child, "height", align, box),
  });
  const { content } = box;
  return {
    element: child,
    rect: {
      ...sized,
      left: add(content.left, alignOffset(justify, content.width, sized.width)),
      top: add(content.top, alignOffset(align, content.height, sized.height)),
    },
  };
}

const INLINE_TAGS = new Set(["span", "a", "img", "svg", "i", "b", "em", "strong", "label"]);

function isInline(child: WebElement): boolean {
  const { display } = child.style;
  return display === undefined ? INLINE_TAGS.has(child.tag) : display.startsWith("inline");
}

/** A size that is declared or else follows the content (never stretched). */
function contentSize(child: WebElement, axis: Axis, box: Container): Len {
  const room = box.content[axis];
  const declared = declaredSize(child, axis, room, box.vars);
  return clampSize(declared === "auto" ? undefined : declared, child, axis, {
    base: room,
    vars: box.vars,
  });
}

/** Block flow: children stack from the top, a block as wide as the container, inline content-wide. */
function placeFlow(children: readonly WebChild[], box: Container): PlacedChild[] {
  const { content } = box;
  const placed: PlacedChild[] = [];
  let cursor: Len = content.top;
  for (const child of children) {
    if (typeof child === "string") {
      // Text takes a line of unmeasured height.
      cursor = child.trim() === "" ? cursor : undefined;
      continue;
    }
    const align = isInline(child) ? "start" : "stretch";
    const rect = withAspectRatio(child, {
      left: content.left,
      top: cursor,
      width: alignedSize(child, "width", align, box),
      height: contentSize(child, "height", box),
    });
    placed.push({ element: child, rect });
    cursor = add(cursor, rect.height);
  }
  return placed;
}

/** A flex item's grow factor and basis, from `flex`, `flex-grow` and `flex-basis`. */
function flexOf(child: WebElement): { grow: number; basis: string } {
  const parts = shorthandValues(child.style.flex);
  let grow = 0;
  let basis = "auto";
  if (parts[0] === "auto") {
    grow = 1;
  } else if (parts.length > 0 && parts[0] !== "none") {
    grow = Number(parts[0]);
    // `flex: 1` and `flex: 1 1` mean a zero basis; a third value (or a length second) names it.
    const named = parts.length === 3 ? parts[2] : parts[1];
    basis = named !== undefined && !/^\d+(\.\d+)?$/.test(named) ? named : "0";
  }
  const explicitGrow = Number(child.style["flex-grow"]);
  return {
    grow: Number.isFinite(explicitGrow) && child.style["flex-grow"] ? explicitGrow : grow || 0,
    basis: child.style["flex-basis"] ?? basis,
  };
}

interface LineItem {
  readonly element?: WebElement;
  readonly base: Len;
  readonly grow: number;
  readonly max: Len;
}

function lineItem(child: WebChild, main: Axis, box: Container): LineItem {
  if (typeof child === "string") {
    return { base: undefined, grow: 0, max: undefined };
  }
  const room = box.content[main];
  const { grow, basis } = flexOf(child);
  const declared =
    basis === "auto" ? declaredSize(child, main, room, box.vars) : cssLength(basis, box.vars, room);
  const base = clampSize(declared === "auto" ? undefined : declared, child, main, {
    base: room,
    vars: box.vars,
  });
  // The minimum wins over the maximum while growing, as in CSS.
  const min = cssLength(child.style[`min-${main}`], box.vars, room);
  const capped = cssLength(child.style[`max-${main}`], box.vars, room);
  const max = capped === undefined ? undefined : Math.max(capped, min ?? -Infinity);
  // A growing item's unmeasured content basis is taken as zero, so it shares the room as
  // `flex: 1` would; its growth, not its content, decides its size.
  return { element: child, base: base === undefined && grow > 0 ? 0 : base, grow, max };
}

/** Free space shared among growing items, each held at its maximum (CSS flex resolution). */
function distribute(items: readonly LineItem[], free: number): { sizes: Len[]; remaining: Len } {
  const sizes: number[] = items.map((item) => item.base ?? 0);
  const frozen = new Set<number>();
  let remaining = free;
  for (let round = 0; round <= items.length && remaining > 0; round++) {
    const active = items.flatMap((item, index) =>
      item.grow > 0 && !frozen.has(index) ? [index] : [],
    );
    const total = active.reduce((sum, index) => sum + items[index]!.grow, 0);
    if (active.length === 0) {
      break;
    }
    // Grow factors summing below 1 take only that fraction of the free space.
    const share = (remaining * Math.min(1, total)) / total;
    const capped = active.filter(
      (index) => sizes[index]! + share * items[index]!.grow > (items[index]!.max ?? Infinity),
    );
    const grown = capped.length > 0 ? capped : active;
    for (const index of grown) {
      const target =
        capped.length > 0 ? items[index]!.max! : sizes[index]! + share * items[index]!.grow;
      remaining -= target - sizes[index]!;
      sizes[index] = target;
      frozen.add(index);
    }
    if (capped.length === 0) {
      remaining = Math.max(0, remaining);
      break;
    }
  }
  return { sizes, remaining };
}

/** Each item's main size after growing, and the free space left for the arrangement. */
function grownSizes(items: readonly LineItem[], free: Len): { sizes: Len[]; remaining: Len } {
  const growers = items.filter((item) => item.grow > 0);
  if (growers.length === 0 || (free !== undefined && free <= 0)) {
    return { sizes: items.map((item) => item.base), remaining: free };
  }
  if (free === undefined) {
    // Unmeasured room: growing items take it all unless every one is capped.
    const capped = growers.every((item) => item.max !== undefined);
    return {
      sizes: items.map((item) => (item.grow > 0 ? undefined : item.base)),
      remaining: capped ? undefined : 0,
    };
  }
  return distribute(items, free);
}

const PACKED_START = new Set([undefined, "normal", "start", "flex-start", "stretch", "left"]);

/** Distributed arrangements by the free space they put before and between `count` items. */
const SPREAD: Readonly<Record<string, (free: number, count: number) => [number, number]>> = {
  "space-between": (free, count) => [0, free / (count - 1)],
  "space-around": (free, count) => [free / (2 * count), free / count],
  "space-evenly": (free, count) => [free / (count + 1), free / (count + 1)],
};

const PACKED_END = new Set<string | undefined>(["end", "flex-end", "right"]);

/** Where the first item starts and the extra room between items, from `justify-content`. */
function arrangement(justify: string | undefined, free: Len, count: number): [Len, Len] {
  if (PACKED_START.has(justify) || (justify === "space-between" && count < 2)) {
    return [0, 0];
  }
  if (free === undefined) {
    // Unmeasured content leaves room, so only a packed start or space-between touches the start.
    return justify === "space-between" ? [0, undefined] : [undefined, undefined];
  }
  if (PACKED_END.has(justify)) {
    return [free, 0];
  }
  const spread = justify === undefined ? undefined : SPREAD[justify];
  if (spread && free >= 0) {
    return spread(free, count);
  }
  // Overflowing, space-between packs at the start and the others centre, as CSS falls back.
  return justify === "space-between" ? [0, 0] : [free / 2, 0];
}

/** The gap between items along the main axis, from `gap` or its longhand. */
function mainGap(main: Axis, box: Container): number {
  const { style } = box.parent;
  const [rowGap, columnGap = rowGap] = shorthandValues(style.gap);
  const value =
    main === "width" ? (style["column-gap"] ?? columnGap) : (style["row-gap"] ?? rowGap);
  return cssLength(value, box.vars, box.content[main]) ?? 0;
}

/** The cross-axis size and offset of a line item, aligned by `align-self` or `align-items`. */
function crossPlacement(child: WebElement, main: Axis, mainSize: Len, box: Container): [Len, Len] {
  const cross = crossOf(main);
  const own = child.style["align-self"];
  const align = own === undefined || own === "auto" ? box.parent.style["align-items"] : own;
  // A ratio-derived cross size is known before alignment places it.
  const size = withAspectRatio(
    child,
    oriented(main, [0, 0], [mainSize, alignedSize(child, cross, align, box)]),
  )[cross];
  return [alignOffset(align, box.content[cross], size), size];
}

/** A flex line: items grow into the free space, then the arrangement places them. */
function placeLine(children: readonly WebChild[], main: Axis, box: Container): PlacedChild[] {
  const cross = crossOf(main);
  const items = children.map((child) => lineItem(child, main, box));
  const gap = mainGap(main, box);
  const room = box.content[main];
  const used = items.reduce<Len>(
    (total, item) => add(total, item.base),
    gap * Math.max(0, items.length - 1),
  );
  // A container sized by its content hugs it, leaving no free space.
  const free = room === undefined ? 0 : sub(room, used);
  const { sizes, remaining } = grownSizes(items, free);
  const [lead, between] = arrangement(box.parent.style["justify-content"], remaining, items.length);
  const placed: PlacedChild[] = [];
  let cursor = add(startOf(box.content, main), lead);
  for (const [index, item] of items.entries()) {
    const size = sizes[index];
    if (item.element) {
      const [offset, crossSize] = crossPlacement(item.element, main, size, box);
      const position: [Len, Len] = [cursor, add(startOf(box.content, cross), offset)];
      const rect = oriented(main, position, [size, crossSize]);
      placed.push({ element: item.element, rect: withAspectRatio(item.element, rect) });
    }
    cursor = add(add(add(cursor, size), gap), between);
  }
  return placed;
}

const elementsOf = (children: readonly WebChild[]): WebElement[] =>
  children.filter((child): child is WebElement => typeof child !== "string");

/** The in-flow children of a container and the border boxes its layout gives them. */
export function placeInFlow(parent: WebElement, content: WebRect, vars: CssVars): PlacedChild[] {
  const children = parent.children.filter(
    (child) => typeof child === "string" || (!outOfFlow(child) && child.style.display !== "none"),
  );
  const box: Container = { parent, content, vars };
  switch (layoutOf(parent)) {
    case "box":
      return elementsOf(children).map((child) => placeInCell(child, box));
    case "tracks":
      return placeTracks(elementsOf(children), trackCount(parent) ?? 1, box);
    case "row":
      return placeLine(children, "width", box);
    case "column":
      return placeLine(children, "height", box);
    case "flow":
      return placeFlow(children, box);
  }
}
