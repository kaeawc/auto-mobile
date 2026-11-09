import { record, type Raw } from "../prototypeTemplate";
import { isWebLayerType } from "./webLayerTypes";
import { ownHeight, verticalPadding, type PrepareChild } from "./webRowAspect";
import { INCOMING_ALLOCATED_KEY, INCOMING_HEIGHT_KEY } from "./webStyle";

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
 * The vertical padding (its safe-area inset included; see verticalPadding) and solid border of a
 * node's box, which `box-sizing: border-box` never lets it shrink below: a `flex: w w 0` item's
 * base size, the height its weight share is added to.
 */
function frame(style: Raw | undefined): number {
  const border = record(style?.border);
  const width =
    typeof border?.width === "number" && border.gradient === undefined ? border.width : 0;
  return verticalPadding(style) + 2 * width;
}

/**
 * Each weighted node's height out of `free`, as CSS's flexible-length algorithm resolves
 * `flex: w w 0` items: each starts at its frame (see frame), and what the frames leave is split
 * over the unfrozen weights (only that fraction of the initial free space when the weights sum
 * below 1). A weight pins its share on both devices, so the node's `maxHeight` and `minHeight` do
 * not clamp it (the renderer drops them; see sizeStyle), but a target never goes below its frame;
 * those so raised freeze, and the loop repeats until every target is frozen, handing what a frame
 * takes from its siblings' shares.
 */
function weightShares(nodes: readonly Raw[], free: number): Map<Raw, number> {
  const frozen = new Map<Raw, number>();
  let open = nodes.filter((node) => weightOf(node) !== undefined);
  const base = (node: Raw) => frame(record(node.style));
  const initial = free - open.reduce((sum, node) => sum + base(node), 0);
  while (open.length > 0) {
    const weights = open.reduce((sum, node) => sum + (weightOf(node) ?? 0), 0);
    const taken = [...frozen.values()].reduce((sum, height) => sum + height, 0);
    const left = free - taken - open.reduce((sum, node) => sum + base(node), 0);
    // Weights summing below 1 take only that fraction of the initial free space, when less.
    const fraction = initial * weights;
    const space = weights < 1 && Math.abs(fraction) < Math.abs(left) ? fraction : left;
    const targets = open.map((node) => {
      const share = base(node) + (space * (weightOf(node) ?? 0)) / weights;
      const height = Math.max(base(node), share);
      return { node, share, height };
    });
    const violation = targets.reduce((sum, target) => sum + target.height - target.share, 0);
    const freezes = targets.filter(
      ({ share, height }) => violation === 0 || (violation > 0 ? height > share : height < share),
    );
    for (const { node, height } of freezes) {
      frozen.set(node, height);
    }
    open = open.filter((node) => !frozen.has(node));
  }
  return frozen;
}

/**
 * The incoming max height of each child of a column with content height `content`, as Compose's
 * Column measures them: each unweighted child in order against what its earlier siblings and the
 * spacing left, then each weighted child against its weight's share of what every unweighted
 * child and the spacing left, each share at least its frame (see weightShares). A sibling with
 * no dp height counts as its minHeight, so the result is an upper bound when one depends on
 * layout. Hidden children (undefined) get no height.
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
  const shares = weightShares(visible, Math.max(0, content - used - gaps));
  return children.map((node, index) =>
    node && shares.has(node) ? shares.get(node) : heights[index],
  );
}

/**
 * Whether a column's weight shares are exact: every visible unweighted child has a dp height or
 * fills what is left (see takenHeight). A wrap-sized sibling counts as its minHeight, so with one
 * present each share is only an upper bound, and a weighted child keeps its own height as a bound
 * too rather than being marked as an allocation.
 */
export function exactWeightShares(children: readonly (Raw | undefined)[]): boolean {
  return children.every((node) => {
    const height = record(node?.style)?.height;
    return (
      node === undefined ||
      weightOf(node) !== undefined ||
      height === "fill" ||
      typeof record(height)?.dp === "number"
    );
  });
}

const childPath = (path: string, index: number) => `${path}.children[${index}]`;

/**
 * A child as it takes part in a column's flow: as `prepare` resolves it, but undefined when it is
 * hoisted into a window layer (see isWebLayerType), open or closed, which leaves nothing in the
 * column, so it takes none of its height and no spacing gap, and is handed none.
 */
const inFlow =
  (prepare: PrepareChild): PrepareChild =>
  (entry, path) => {
    const node = prepare(entry, path);
    return node && isWebLayerType(node.type) ? undefined : node;
  };

/**
 * `entry` with `height` as its incoming height, marked as an allocation (INCOMING_ALLOCATED_KEY)
 * when `allocated` (a weighted child's exact share; see exactWeightShares), so its own dp height
 * and height bounds do not cap it.
 */
function withHeight(entry: unknown, height: number | undefined, allocated: boolean): unknown {
  const node = record(entry);
  if (!node || height === undefined || height === Infinity) {
    return entry;
  }
  const style = { ...record(node.style), [INCOMING_HEIGHT_KEY]: height };
  return { ...node, style: allocated ? { ...style, [INCOMING_ALLOCATED_KEY]: true } : style };
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
 * `prepare` resolves a child as rendering will (bound, visible, `styleWhen` merged), in the
 * column's child scope: an inset edge the column applies is consumed, so a child asking for the
 * same edge carries none of it in its frame (see weightShares).
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
  const prepared = children.map((entry, index) => inFlow(prepare)(entry, childPath(path, index)));
  const heights = columnChildHeights(
    prepared,
    content,
    parent.spacing && typeof spacing === "number" ? spacing : 0,
  );
  const exact = exactWeightShares(prepared);
  return {
    ...node,
    children: children.map((entry, index) =>
      withHeight(entry, heights[index], exact && weightOf(prepared[index]) !== undefined),
    ),
  };
}

/**
 * A repeat's template children once per instance, each carrying the incoming max height it gets
 * (INCOMING_HEIGHT_KEY). In a column with content height `content`, the instances are siblings,
 * so Compose's Column measures every expanded child in order (see columnChildHeights): two
 * weighted instances in a 40 dp column get 20 dp each, not 40. Any other repeat, or one with no
 * known content height, keeps the template as given. The renderer passes the bound its scope
 * carries, which a line sets to its own content height for its children.
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
    template.map((entry, index) => inFlow(prepare)(entry, childPath(path, index))),
  );
  const spacing = record(node.style)?.spacing;
  const heights = columnChildHeights(prepared, content, typeof spacing === "number" ? spacing : 0);
  const exact = exactWeightShares(prepared);
  return prepares.map((_prepare, instance) =>
    template.map((entry, index) => {
      const at = instance * template.length + index;
      return withHeight(entry, heights[at], exact && weightOf(prepared[at]) !== undefined);
    }),
  );
}
