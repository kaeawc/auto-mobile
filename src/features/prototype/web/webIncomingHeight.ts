import { record, type Raw } from "../prototypeTemplate";
import { ownHeight, type PrepareChild } from "./webRowAspect";
import { INCOMING_HEIGHT_KEY } from "./webStyle";

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
 * child and the spacing left. A sibling with no dp height counts as its minHeight, so the result
 * is an upper bound when one depends on layout. Hidden children (undefined) get no height.
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
 * The containers that lay out their children as a column, and whether they apply `spacing`. A
 * card lays out its content in a column, as Material's Card does, with no spacing. A Map, so a node
 * type like `toString` cannot match an `Object.prototype` key.
 */
const COLUMN_PARENTS: ReadonlyMap<unknown, { readonly spacing: boolean }> = new Map([
  ["column", { spacing: true }],
  ["card", { spacing: false }],
]);

/**
 * A column or card with each child carrying the share of its content height `content` it hands
 * that child (INCOMING_HEIGHT_KEY; see columnChildHeights); other nodes unchanged. The render scope
 * already passes every child the whole content height, which is all a row or a box hands on, so
 * only a plain column or a card narrows it; a repeat column's children are one template, so
 * repeatInstanceChildren hands each instance its own share instead. A height that depends on
 * layout (a sibling's wrap height, the screen) is left out, so the bound stays an upper one.
 *
 * `prepare` resolves a child as rendering will (bound, visible, `styleWhen` merged).
 */
export function withColumnHeights(
  node: Raw,
  path: string,
  prepare: PrepareChild,
  content: number | undefined,
): Raw {
  const { children } = node;
  const parent = COLUMN_PARENTS.get(node.type);
  if (!parent || node.repeat !== undefined || !Array.isArray(children) || content === undefined) {
    return node;
  }
  const spacing = record(node.style)?.spacing;
  const heights = columnChildHeights(
    children.map((entry, index) => prepare(entry, childPath(path, index))),
    content,
    parent.spacing && typeof spacing === "number" ? spacing : 0,
  );
  return { ...node, children: children.map((entry, index) => withHeight(entry, heights[index])) };
}

/**
 * A repeat's template children once per instance, each carrying the incoming max height it gets
 * (INCOMING_HEIGHT_KEY). In a column with content height `content`, the instances are siblings,
 * so Compose's Column measures every expanded child in order (see columnChildHeights): two
 * weighted instances in a 40 dp column get 20 dp each, not 40. Any other repeat, or one with no
 * known content height, keeps the template as given.
 *
 * `prepares` holds one PrepareChild per instance, resolving a template child in that instance's
 * scope (its placeholders bound, `visibleWhen` and `styleWhen` applied).
 */
export function repeatInstanceChildren(
  node: Raw,
  path: string,
  prepares: readonly PrepareChild[],
  content: number | undefined,
): unknown[][] {
  const template = Array.isArray(node.children) ? node.children : [];
  if (node.type !== "column" || node.repeat === undefined || content === undefined) {
    return prepares.map(() => template);
  }
  const prepared = prepares.flatMap((prepare) =>
    template.map((entry, index) => prepare(entry, childPath(path, index))),
  );
  const spacing = record(node.style)?.spacing;
  const heights = columnChildHeights(prepared, content, typeof spacing === "number" ? spacing : 0);
  return prepares.map((_prepare, instance) =>
    template.map((entry, index) => withHeight(entry, heights[instance * template.length + index])),
  );
}
