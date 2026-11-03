import { record, type Raw } from "../prototypeTemplate";
import type { PrepareChild } from "./webRowAspect";
import { INCOMING_HEIGHT_EXACT_KEY, INCOMING_HEIGHT_KEY } from "./webStyle";

const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : Infinity;

const side = (padding: Raw | undefined, name: string) =>
  typeof padding?.[name] === "number" ? padding[name] : 0;

/** `height` held under the node's `maxHeight`, then raised to its `minHeight`, which wins. */
function clamped(style: Raw | undefined, height: number): number {
  const floor = typeof style?.minHeight === "number" ? style.minHeight : 0;
  return Math.max(floor, Math.min(height, finite(style?.maxHeight)));
}

/**
 * The height a node's own size takes, as CSS and Compose's `sizeIn` then `height` resolve it: its
 * dp `height` (else unbounded) held under `maxHeight`, then raised to `minHeight`, which wins.
 */
function ownHeight(style: Raw | undefined): number {
  return clamped(style, finite(record(style?.height)?.dp));
}

/**
 * The height a node's box takes within what its parent hands it (INCOMING_HEIGHT_KEY): an exact
 * allocation (INCOMING_HEIGHT_EXACT_KEY, a column's weight share) within its own min and max
 * height, overriding any dp `height`, as Compose's weight constraint and the web's flex share do;
 * otherwise its own height (see ownHeight) within the incoming max.
 */
function boxHeight(style: Raw | undefined): number {
  const incoming = finite(style?.[INCOMING_HEIGHT_KEY]);
  if (style?.[INCOMING_HEIGHT_EXACT_KEY] === true && incoming !== Infinity) {
    return clamped(style, incoming);
  }
  return Math.min(incoming, ownHeight(style));
}

/**
 * The tallest a node lets its children be: its box height (see boxHeight) less its vertical
 * padding. A `fill`, weighted or wrap-sized node is bounded by the incoming height alone, as
 * Compose's incoming max height bounds it; a column-weighted node takes its share even over an
 * authored dp height. Infinity when no bound is statically known.
 */
export function contentHeight(style: Raw | undefined): number {
  const bound = boxHeight(style);
  const padding = record(style?.padding);
  return Math.max(0, bound - side(padding, "top") - side(padding, "bottom"));
}

const weightOf = (node: Raw | undefined): number | undefined => {
  const weight = record(node?.style)?.weight;
  return typeof weight === "number" && weight > 0 ? weight : undefined;
};

/**
 * The height an unweighted child takes when `remaining` is left: its dp height clamped by its
 * bounds (see ownHeight). A `fill` child takes everything left, within its bounds, as Compose's
 * `fillMaxHeight` does in a Column, so a later sibling, weighted or not, gets nothing. With no dp
 * height it wraps its content, which is only known at layout time, so it counts as its
 * `minHeight` (else 0), never its `maxHeight`, and the rest is an upper bound.
 */
const takenHeight = (node: Raw, remaining: number): number => {
  const style = record(node.style);
  if (style?.height === "fill") {
    return Math.min(remaining, ownHeight(style));
  }
  const floor = typeof style?.minHeight === "number" ? style.minHeight : 0;
  return typeof record(style?.height)?.dp === "number" ? ownHeight(style) : floor;
};

/**
 * The incoming max height of each child of a column with content height `content`, as Compose's
 * Column measures them: each unweighted child in order against what its earlier siblings and the
 * spacing left, then each weighted child against its weight's share of what every unweighted
 * child and the spacing left. A sibling with no dp height counts as 0, so the result is an upper
 * bound when one depends on layout. Hidden children (undefined) get no height.
 *
 * CSS gives a `fill` child `flex: 1 1 auto`, which shares the height with its weighted siblings;
 * the bound follows Compose instead, where the `fill` child takes it all.
 */
export function columnChildHeights(
  children: readonly (Raw | undefined)[],
  content: number,
  spacing: number,
): (number | undefined)[] {
  const visible = children.filter((node): node is Raw => node !== undefined);
  const gaps = spacing * Math.max(0, visible.length - 1);
  const weights = visible.reduce((sum, node) => sum + (weightOf(node) ?? 0), 0);
  const heights: (number | undefined)[] = [];
  let before = 0;
  let used = 0;
  for (const node of children) {
    if (!node || weightOf(node) !== undefined) {
      heights.push(undefined);
      continue;
    }
    const incoming = Math.max(0, content - before);
    const taken = takenHeight(node, incoming);
    heights.push(incoming);
    before += taken + spacing;
    used += taken;
  }
  const share = Math.max(0, content - used - gaps) / (weights || 1);
  return children.map((node, index) => {
    const weight = weightOf(node);
    return node && weight !== undefined ? share * weight : heights[index];
  });
}

const childPath = (path: string, index: number) => `${path}.children[${index}]`;

/**
 * `entry` carrying the incoming `height` its parent hands it, marked exact when `exact` (a column's
 * weight share) and otherwise a max, clearing any exact mark a template copy carried.
 */
function withHeight(entry: unknown, height: number | undefined, exact = false): unknown {
  const node = record(entry);
  if (!node || height === undefined || height === Infinity) {
    return entry;
  }
  const style: Raw = { ...record(node.style), [INCOMING_HEIGHT_KEY]: height };
  if (exact) {
    style[INCOMING_HEIGHT_EXACT_KEY] = true;
  } else {
    delete style[INCOMING_HEIGHT_EXACT_KEY];
  }
  return { ...node, style };
}

/** Whether a column hands this resolved child an exact allocation: its weight share. */
const exactIn = (prepared: Raw | undefined) => weightOf(prepared) !== undefined;

/**
 * A row, column or box with each child carrying the incoming max height it hands that child
 * (INCOMING_HEIGHT_KEY), where the node's own content height is statically known; other nodes
 * unchanged. A row or box hands every child its content height. A column measures its children
 * in order (see columnChildHeights), except a repeat, whose children are one template, so each
 * gets the whole content height as a bound until repeatInstanceChildren hands each instance its
 * own share. A column's weighted child gets its share as an exact allocation
 * (INCOMING_HEIGHT_EXACT_KEY); a row's weight is horizontal, so its children's dp heights still
 * hold. A height that depends on layout (a sibling's wrap
 * height, the screen) is left out, so the bound stays an upper one or is absent.
 *
 * `prepare` resolves a child as rendering will (bound, visible, `styleWhen` merged).
 */
export function withChildHeights(node: Raw, path: string, prepare: PrepareChild): Raw {
  const { type, children } = node;
  if ((type !== "row" && type !== "column" && type !== "box") || !Array.isArray(children)) {
    return node;
  }
  const style = record(node.style);
  const content = contentHeight(style);
  if (content === Infinity) {
    return node;
  }
  if (type !== "column" || node.repeat !== undefined) {
    return { ...node, children: children.map((entry) => withHeight(entry, content)) };
  }
  const prepared = children.map((entry, index) => prepare(entry, childPath(path, index)));
  const spacing = typeof style?.spacing === "number" ? style.spacing : 0;
  const heights = columnChildHeights(prepared, content, spacing);
  return {
    ...node,
    children: children.map((entry, index) =>
      withHeight(entry, heights[index], exactIn(prepared[index])),
    ),
  };
}

/**
 * A repeat's template children once per instance, each carrying the incoming max height it gets
 * (INCOMING_HEIGHT_KEY). In a column with a statically known content height, the instances are
 * siblings, so Compose's Column measures every expanded child in order (see columnChildHeights):
 * two weighted instances in a 40 dp column get 20 dp each, not 40. Any other repeat keeps the
 * template as given, whose children withChildHeights already bounded.
 *
 * `prepares` holds one PrepareChild per instance, resolving a template child in that instance's
 * scope (its placeholders bound, `visibleWhen` and `styleWhen` applied).
 */
export function repeatInstanceChildren(
  node: Raw,
  path: string,
  prepares: readonly PrepareChild[],
): unknown[][] {
  const template = Array.isArray(node.children) ? node.children : [];
  const style = record(node.style);
  const content = contentHeight(style);
  if (node.type !== "column" || content === Infinity) {
    return prepares.map(() => template);
  }
  const prepared = prepares.flatMap((prepare) =>
    template.map((entry, index) => prepare(entry, childPath(path, index))),
  );
  const spacing = typeof style?.spacing === "number" ? style.spacing : 0;
  const heights = columnChildHeights(prepared, content, spacing);
  return prepares.map((_prepare, instance) =>
    template.map((entry, index) => {
      const at = instance * template.length + index;
      return withHeight(entry, heights[at], exactIn(prepared[at]));
    }),
  );
}
