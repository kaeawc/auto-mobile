import { record, type Raw } from "../prototypeTemplate";
import type { PrepareChild } from "./webRowAspect";
import { INCOMING_HEIGHT_KEY } from "./webStyle";

const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : Infinity;

const side = (padding: Raw | undefined, name: string) =>
  typeof padding?.[name] === "number" ? padding[name] : 0;

/**
 * The height a node's own size takes, as CSS and Compose's `sizeIn` then `height` resolve it: its
 * dp `height` (else unbounded) held under `maxHeight`, then raised to `minHeight`, which wins.
 */
function ownHeight(style: Raw | undefined): number {
  const capped = Math.min(finite(record(style?.height)?.dp), finite(style?.maxHeight));
  const floor = typeof style?.minHeight === "number" ? style.minHeight : 0;
  return Math.max(floor, capped);
}

/**
 * The tallest a node lets its children be: its own height (see ownHeight) within the height its
 * parent hands it (INCOMING_HEIGHT_KEY), less its vertical padding. A `fill`, weighted or
 * wrap-sized node is bounded by the incoming height alone, as Compose's incoming max height
 * bounds it. Infinity when no bound is statically known.
 */
export function contentHeight(style: Raw | undefined): number {
  const bound = Math.min(finite(style?.[INCOMING_HEIGHT_KEY]), ownHeight(style));
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

function withHeight(entry: unknown, height: number | undefined): unknown {
  const node = record(entry);
  if (!node || height === undefined || height === Infinity) {
    return entry;
  }
  return { ...node, style: { ...record(node.style), [INCOMING_HEIGHT_KEY]: height } };
}

/**
 * A row, column or box with each child carrying the incoming max height it hands that child
 * (INCOMING_HEIGHT_KEY), where the node's own content height is statically known; other nodes
 * unchanged. A row or box hands every child its content height. A column measures its children
 * in order (see columnChildHeights), except a repeat, whose children are one template, so each
 * gets the whole content height as a bound until repeatInstanceChildren hands each instance its
 * own share. A height that depends on layout (a sibling's wrap
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
  const heights =
    type === "column" && node.repeat === undefined
      ? columnChildHeights(
          children.map((entry, index) => prepare(entry, childPath(path, index))),
          content,
          typeof style?.spacing === "number" ? style.spacing : 0,
        )
      : children.map(() => content);
  return { ...node, children: children.map((entry, index) => withHeight(entry, heights[index])) };
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
    template.map((entry, index) => withHeight(entry, heights[instance * template.length + index])),
  );
}
