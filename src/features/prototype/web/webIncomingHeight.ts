import { record, type Raw } from "../prototypeTemplate";
import { ownHeight, type PrepareChild } from "./webRowAspect";
import { INCOMING_HEIGHT_KEY } from "./webStyle";

const weightOf = (node: Raw | undefined): number | undefined => {
  const weight = record(node?.style)?.weight;
  return typeof weight === "number" && weight > 0 ? weight : undefined;
};

/**
 * The height an unweighted child takes: its dp height clamped by its bounds (see ownHeight). With
 * no dp height it wraps its content, which is only known at layout time, so it counts as its
 * `minHeight` (else 0), never its `maxHeight`, and the rest is an upper bound.
 */
const fixedHeight = (node: Raw): number => {
  const style = record(node.style);
  if (weightOf(node) !== undefined) {
    return 0;
  }
  const floor = typeof style?.minHeight === "number" ? style.minHeight : 0;
  return typeof record(style?.height)?.dp === "number" ? ownHeight(style) : floor;
};

/**
 * The incoming max height of each child of a column with content height `content`, as Compose's
 * Column measures them: an unweighted child against what its earlier siblings and the spacing
 * left, then each weighted child against its weight's share of what every unweighted child and
 * the spacing left. A sibling with no dp height counts as its minHeight, so the result is an upper
 * bound when one depends on layout. Hidden children (undefined) get no height.
 */
export function columnChildHeights(
  children: readonly (Raw | undefined)[],
  content: number,
  spacing: number,
): (number | undefined)[] {
  const visible = children.filter((node): node is Raw => node !== undefined);
  const used = visible.reduce((sum, node) => sum + fixedHeight(node), 0);
  const gaps = spacing * Math.max(0, visible.length - 1);
  const weights = visible.reduce((sum, node) => sum + (weightOf(node) ?? 0), 0);
  const share = Math.max(0, content - used - gaps) / (weights || 1);
  const heights: (number | undefined)[] = [];
  let before = 0;
  for (const node of children) {
    const weight = weightOf(node);
    if (!node) {
      heights.push(undefined);
    } else if (weight !== undefined) {
      heights.push(share * weight);
    } else {
      heights.push(Math.max(0, content - before));
      before += fixedHeight(node) + spacing;
    }
  }
  return heights;
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
 * A column with each child carrying the share of its content height `content` it hands that child
 * (INCOMING_HEIGHT_KEY; see columnChildHeights); other nodes unchanged. The render scope already
 * passes every child the whole content height, which is all a row, a box or a repeat column (whose
 * children are one template) hands on, so only a plain column narrows it. A height that depends
 * on layout (a sibling's wrap height, the screen) is left out, so the bound stays an upper one.
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
  if (
    node.type !== "column" ||
    node.repeat !== undefined ||
    !Array.isArray(children) ||
    content === undefined
  ) {
    return node;
  }
  const spacing = record(node.style)?.spacing;
  const heights = columnChildHeights(
    children.map((entry, index) => prepare(entry, childPath(path, index))),
    content,
    typeof spacing === "number" ? spacing : 0,
  );
  return { ...node, children: children.map((entry, index) => withHeight(entry, heights[index])) };
}
