import { cssLength, type CssVars } from "./webCssLength";
import {
  add,
  alignOffset,
  aspectRatioOf,
  clampKnown,
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

/** Whether a flex line runs from its main-end (`row-reverse` or `column-reverse`). */
const reversed = (element: WebElement): boolean =>
  element.style["flex-direction"]?.trim().endsWith("-reverse") === true;

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
 * A content size stays unknown so an aspect ratio can still derive it; `withAspectRatio` then
 * takes it at its minimum.
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
    declared !== "auto"
      ? declared
      : stretched
        ? room
        : aspectRatioOf(child) === undefined
          ? measuredContent(child, axis, box.vars, 0)
          : undefined;
  return clampKnown(size, child, axis, { base: room, vars: box.vars });
}

const MAX_MEASURE_DEPTH = 32;

/** An element's size on one axis with no room to resolve against: declared, else measured. */
function measuredSize(element: WebElement, axis: Axis, vars: CssVars, depth: number): Len {
  const declared = declaredSize(element, axis, undefined, vars);
  const size =
    declared !== "auto"
      ? declared
      : aspectRatioOf(element) === undefined
        ? measuredContent(element, axis, vars, depth)
        : undefined;
  return clampKnown(size, element, axis, { base: undefined, vars });
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
  const sized = withAspectRatio(
    child,
    {
      left: 0,
      top: 0,
      width: alignedSize(child, "width", justify, box),
      height: alignedSize(child, "height", align, box),
    },
    box.content,
    box.vars,
  );
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

/** A size that is declared or else follows the content (never stretched), unknown until resolved. */
function contentSize(child: WebElement, axis: Axis, box: Container): Len {
  const room = box.content[axis];
  const declared = declaredSize(child, axis, room, box.vars);
  return clampKnown(declared === "auto" ? undefined : declared, child, axis, {
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
    const rect = withAspectRatio(
      child,
      {
        left: content.left,
        top: cursor,
        width: alignedSize(child, "width", align, box),
        height: contentSize(child, "height", box),
      },
      content,
      box.vars,
    );
    placed.push({ element: child, rect });
    cursor = add(cursor, rect.height);
  }
  return placed;
}

/** A flex item's factors and basis: `flex`, then `flex-grow`, `flex-shrink` and `flex-basis`. */
function flexOf(child: WebElement): { grow: number; shrink: number; basis: string } {
  const parts = shorthandValues(child.style.flex);
  const isNumber = (part: string | undefined): boolean =>
    part !== undefined && /^\d*\.?\d+$/.test(part);
  let grow = 0;
  let shrink = 1;
  let basis = "auto";
  if (parts[0] === "none") {
    shrink = 0;
  } else if (parts[0] === "auto") {
    grow = 1;
  } else if (parts.length > 0 && parts[0] !== "initial") {
    // `flex: 1` and `flex: 1 1` mean a zero basis; a lone length means `1 1 <length>`.
    const numbers = parts.filter(isNumber);
    grow = numbers.length > 0 ? Number(numbers[0]) : 1;
    shrink = numbers.length > 1 ? Number(numbers[1]) : 1;
    basis = parts.find((part) => !isNumber(part)) ?? "0";
  }
  const longhand = (name: string, fallback: number): number => {
    const value = Number(child.style[name]);
    return child.style[name] && Number.isFinite(value) ? value : fallback;
  };
  return {
    grow: longhand("flex-grow", grow),
    shrink: longhand("flex-shrink", shrink),
    basis: child.style["flex-basis"] ?? basis,
  };
}

/**
 * A line item. `basis` is its flex base size and `base` its hypothetical main size (the basis
 * clamped by its min and max). Its minimum and maximum are resolved in the freeze rounds, as CSS
 * does. `min` is the declared `min-*`, else the automatic minimum when the pass can know it;
 * `minUnknown` marks an automatic minimum that depends on unmeasured content. `edges` is its
 * main-axis padding and border, which the inner flex base size excludes.
 */
interface LineItem {
  readonly element?: WebElement;
  readonly basis: Len;
  readonly base: Len;
  readonly grow: number;
  readonly shrink: number;
  readonly min: Len;
  readonly max: Len;
  readonly minUnknown: boolean;
  readonly edges: number;
}

/** A line item's self-alignment on the cross axis: `align-self`, else the line's `align-items`. */
function crossAlign(child: WebElement, box: Container): string | undefined {
  const own = child.style["align-self"];
  return own === undefined || own === "auto" ? box.parent.style["align-items"] : own;
}

/**
 * An `auto` main size transferred from the item's cross size through its `aspect-ratio`, before
 * any main-axis `min-*` or `max-*`; unknown when the item has no ratio or its cross size is unknown.
 * A flex basis is determined without those constraints (CSS 9.2 step 3B).
 */
function ratioMainSize(child: WebElement, main: Axis, box: Container): Len {
  const ratio = aspectRatioOf(child);
  const crossSize = alignedSize(child, crossOf(main), crossAlign(child, box), box);
  if (ratio === undefined || crossSize === undefined) {
    return undefined;
  }
  return main === "width" ? crossSize * ratio : crossSize / ratio;
}

/** The ratio-derived main size clamped by the item's main-axis `min-*` and `max-*`. */
function clampedRatioMainSize(child: WebElement, main: Axis, box: Container): Len {
  const crossSize = alignedSize(child, crossOf(main), crossAlign(child, box), box);
  const rect = oriented(main, [0, 0], [undefined, crossSize]);
  return withAspectRatio(child, rect, box.content, box.vars)[main];
}

const REPLACED_TAGS = new Set(["img", "svg", "video", "canvas", "iframe", "input"]);

/**
 * A line item's automatic minimum (CSS `min-*: auto`): zero for a scroll container, else its
 * content size, capped by a declared size. The content size is the ratio-derived size when there
 * is one, zero for an empty box, and unknown otherwise, since content is not measured.
 */
function automaticMinimum(child: WebElement, main: Axis, box: Container): Len {
  const overflow =
    child.style.overflow ?? child.style[main === "width" ? "overflow-x" : "overflow-y"];
  if (overflow !== undefined && overflow !== "visible") {
    return 0;
  }
  const empty =
    !REPLACED_TAGS.has(child.tag) &&
    child.children.every(
      (grandchild) => typeof grandchild === "string" && grandchild.trim() === "",
    );
  const content = clampedRatioMainSize(child, main, box) ?? (empty ? 0 : undefined);
  const declared = declaredSize(child, main, box.content[main], box.vars);
  const specified = declared === "auto" ? undefined : declared;
  if (specified === undefined || content === undefined) {
    return content;
  }
  return Math.min(specified, content);
}

/** A line item's main-axis padding plus border; an unresolved side counts as zero. */
function mainEdges(child: WebElement, main: Axis, box: Container): number {
  const insets = contentInsets(child, box.content[main], box.vars);
  const edges = main === "width" ? add(insets.left, insets.right) : add(insets.top, insets.bottom);
  return edges ?? 0;
}

/**
 * A line item's minimum main size: its declared `min-*`, else its automatic minimum, floored at
 * its padding and border. `minUnknown` marks an automatic minimum that depends on content.
 */
function mainMinimum(
  child: WebElement,
  main: Axis,
  box: Container,
): { min: Len; minUnknown: boolean } {
  const explicitMin = cssLength(child.style[`min-${main}`], box.vars, box.content[main]);
  const automatic = explicitMin === undefined ? automaticMinimum(child, main, box) : undefined;
  // A border box is never narrower than its padding and border, whatever its minimum says.
  const floor = mainEdges(child, main, box);
  const declaredMin = explicitMin ?? automatic;
  const min =
    declaredMin === undefined && floor === 0 ? undefined : Math.max(declaredMin ?? 0, floor);
  return { min, minUnknown: explicitMin === undefined && automatic === undefined };
}

function lineItem(child: WebChild, main: Axis, box: Container): LineItem {
  if (typeof child === "string") {
    const none = undefined;
    const text = { basis: none, base: none, grow: 0, shrink: 0, min: none, max: none };
    return { ...text, minUnknown: true, edges: 0 };
  }
  const room = box.content[main];
  const { grow, shrink, basis: basisValue } = flexOf(child);
  const declared =
    basisValue === "auto"
      ? declaredSize(child, main, room, box.vars)
      : cssLength(basisValue, box.vars, room);
  const max = cssLength(child.style[`max-${main}`], box.vars, room);
  const { min, minUnknown } = mainMinimum(child, main, box);
  // A content-sized item with an aspect ratio and a known cross size takes its main size from both.
  const size = declared === "auto" ? ratioMainSize(child, main, box) : declared;
  const edges = mainEdges(child, main, box);
  // A growing item's unmeasured content is taken as zero, so its border-box basis is its padding
  // and border; it shares the room as `flex: 1` would, and its growth decides its size.
  const basis = grow > 0 ? (size ?? edges) : size;
  const base =
    basis === undefined
      ? clampSize(undefined, child, main, { base: room, vars: box.vars })
      : Math.max(min ?? 0, Math.min(max ?? Infinity, basis));
  return { element: child, basis, base, grow, shrink, min, max, minUnknown, edges };
}

/** The items to freeze this round: those at the clamp the total violation's sign names. */
function violators(
  active: readonly number[],
  targets: Map<number, number>,
  clamped: Map<number, number>,
): readonly number[] {
  const violation = active.reduce(
    (sum, index) => sum + clamped.get(index)! - targets.get(index)!,
    0,
  );
  if (violation === 0) {
    return active;
  }
  return active.filter((index) =>
    violation > 0
      ? clamped.get(index)! > targets.get(index)!
      : clamped.get(index)! < targets.get(index)!,
  );
}

/** Whether the line grows into positive free space or shrinks out of negative free space. */
type FlexMode = "grow" | "shrink";

/**
 * Whether an item flexes: it has a factor for the mode and its hypothetical size does not already
 * pass its basis in the mode's direction (CSS 9.7 step 2). A shrinking item whose automatic
 * minimum depends on unmeasured content keeps its size.
 */
function isFlexible(item: LineItem, mode: FlexMode): boolean {
  if (item.basis === undefined || item.base === undefined) {
    return false;
  }
  return mode === "grow"
    ? item.grow > 0 && item.basis <= item.base
    : item.shrink > 0 && item.basis >= item.base && !item.minUnknown;
}

/** An item's target in a round: its basis plus its share of the round's free space. */
function targetOf(item: LineItem, active: readonly LineItem[], share: number, mode: FlexMode) {
  const basis = item.basis ?? 0;
  if (mode === "grow") {
    const total = active.reduce((sum, other) => sum + other.grow, 0);
    return basis + (share * item.grow) / total;
  }
  // Negative free space is shared by flex-shrink scaled by the inner flex base size, the basis
  // less padding and border (9.7 step 4c).
  const scaledOf = (other: LineItem): number =>
    other.shrink * Math.max(0, (other.basis ?? 0) - other.edges);
  const scaled = active.reduce((sum, other) => sum + scaledOf(other), 0);
  return scaled === 0 ? basis : basis + (share * scaledOf(item)) / scaled;
}

/**
 * Free space shared among flexible items, each held between its minimum and maximum (CSS flex
 * resolution, 9.7). Positive space grows items by grow factor; negative space shrinks them by
 * shrink factor times inner basis. Each round shares what the frozen items left of the initial free
 * space; when the unfrozen factors sum below 1, they take at most that fraction of it.
 */
function distribute(
  items: readonly LineItem[],
  free: number,
  mode: FlexMode,
): { sizes: Len[]; remaining: Len } {
  const starts: number[] = items.map((item) =>
    isFlexible(item, mode) ? item.basis! : (item.base ?? 0),
  );
  const sizes = [...starts];
  const frozen = new Set(items.flatMap((item, index) => (isFlexible(item, mode) ? [] : [index])));
  const flexedBy = (): number => sizes.reduce((sum, size, index) => sum + size - starts[index]!, 0);
  while (frozen.size < items.length) {
    const active = items.flatMap((_, index) => (frozen.has(index) ? [] : [index]));
    const activeItems = active.map((index) => items[index]!);
    const total = activeItems.reduce((sum, item) => sum + item[mode], 0);
    const left = free - flexedBy();
    const share = total < 1 && Math.abs(free * total) < Math.abs(left) ? free * total : left;
    const targets = new Map(
      active.map((index) => [index, targetOf(items[index]!, activeItems, share, mode)]),
    );
    const clamped = new Map(
      active.map((index) => {
        const { min, max } = items[index]!;
        return [index, Math.max(min ?? 0, Math.min(max ?? Infinity, targets.get(index)!))];
      }),
    );
    for (const index of violators(active, targets, clamped)) {
      sizes[index] = clamped.get(index)!;
      frozen.add(index);
    }
  }
  const remaining = free - flexedBy();
  return { sizes, remaining: mode === "grow" ? Math.max(0, remaining) : remaining };
}

/** Each item's main size after flexing, and the free space left for the arrangement. */
function flexedSizes(
  items: readonly LineItem[],
  room: Len,
  gaps: number,
): { sizes: Len[]; remaining: Len } {
  const bases = items.map((item) => item.base);
  // A container sized by its content hugs it, leaving no free space.
  if (room === undefined) {
    return { sizes: bases, remaining: 0 };
  }
  const hypothetical = bases.reduce<Len>((total, base) => add(total, base), gaps);
  const growers = items.filter((item) => item.grow > 0);
  if (hypothetical === undefined) {
    // Unmeasured content: growing items take the room unless every one is capped.
    const capped = growers.every((item) => item.max !== undefined);
    return {
      sizes: items.map((item) => (item.grow > 0 ? undefined : item.base)),
      remaining: growers.length > 0 && !capped ? 0 : undefined,
    };
  }
  if (hypothetical === room) {
    return { sizes: bases, remaining: 0 };
  }
  const mode: FlexMode = hypothetical < room ? "grow" : "shrink";
  const flexible = items.filter((item) => isFlexible(item, mode));
  if (flexible.length === 0) {
    return { sizes: bases, remaining: room - hypothetical };
  }
  // Initial free space: inflexible items at their hypothetical size, flexible ones at their basis.
  const used = items.reduce(
    (total, item) => total + (isFlexible(item, mode) ? item.basis! : item.base!),
    gaps,
  );
  return distribute(items, room - used, mode);
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
  const align = crossAlign(child, box);
  // A ratio-derived cross size is known before alignment places it.
  const size = withAspectRatio(
    child,
    oriented(main, [0, 0], [mainSize, alignedSize(child, cross, align, box)]),
    box.content,
    box.vars,
  )[cross];
  return [alignOffset(align, box.content[cross], size), size];
}

/** The container-side keywords a reversed line swaps so they stay put once it is mirrored. */
const SIDE_SWAP: Readonly<Record<string, string>> = {
  start: "end",
  end: "start",
  left: "right",
  right: "left",
};

/**
 * `justify-content` as an offset from the line's main-start. `start`, `end`, `left` and `right`
 * name the container's own sides, so in a reversed line they swap to stay put once the line is
 * mirrored; `flex-start`, `flex-end` and the `space-*` arrangements follow the line. `left` and
 * `right` mean `start` on a column, as CSS has them off the inline axis.
 */
function lineJustify(
  justify: string | undefined,
  main: Axis,
  reverse: boolean,
): string | undefined {
  const physical =
    main === "height" && (justify === "left" || justify === "right") ? "start" : justify;
  if (!reverse) {
    return physical;
  }
  return physical === undefined ? undefined : (SIDE_SWAP[physical] ?? physical);
}

/**
 * Each item's offset from its line's main-start: the arrangement's lead, then each item's size,
 * the gap and the arrangement's spacing in turn.
 */
function forwardOffsets(sizes: readonly Len[], gap: number, [lead, between]: [Len, Len]): Len[] {
  let cursor = lead;
  return sizes.map((size) => {
    const offset = cursor;
    cursor = add(add(add(cursor, size), gap), between);
    return offset;
  });
}

/**
 * Each item's offset from its line's physical start. A reversed line runs from its main-end, so
 * an item sits back from the end of the line by its forward offset and its own size. A line
 * sized by its content has no free space, so there an item sits after the items that follow it
 * in source order: the last one starts at the line's start even when another size is unknown.
 */
function physicalOffsets(
  sizes: readonly Len[],
  gap: number,
  room: Len,
  arranged: [Len, Len],
): Len[] {
  if (room !== undefined) {
    return forwardOffsets(sizes, gap, arranged).map((offset, index) =>
      sub(room, add(offset, sizes[index])),
    );
  }
  return forwardOffsets([...sizes].reverse(), gap, [0, 0]).reverse();
}

/** A flex line: items grow into the free space, then the arrangement places them. */
function placeLine(children: readonly WebChild[], main: Axis, box: Container): PlacedChild[] {
  const cross = crossOf(main);
  const items = children.map((child) => lineItem(child, main, box));
  const gap = mainGap(main, box);
  const room = box.content[main];
  const gaps = gap * Math.max(0, items.length - 1);
  const { sizes, remaining } = flexedSizes(items, room, gaps);
  const reverse = reversed(box.parent);
  const justify = lineJustify(box.parent.style["justify-content"], main, reverse);
  const arranged = arrangement(justify, remaining, items.length);
  const offsets = reverse
    ? physicalOffsets(sizes, gap, room, arranged)
    : forwardOffsets(sizes, gap, arranged);
  const placed: PlacedChild[] = [];
  for (const [index, item] of items.entries()) {
    const size = sizes[index];
    if (item.element) {
      const [offset, crossSize] = crossPlacement(item.element, main, size, box);
      const position: [Len, Len] = [
        add(startOf(box.content, main), offsets[index]),
        add(startOf(box.content, cross), offset),
      ];
      const rect = oriented(main, position, [size, crossSize]);
      placed.push({
        element: item.element,
        rect: withAspectRatio(item.element, rect, box.content, box.vars),
      });
    }
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
