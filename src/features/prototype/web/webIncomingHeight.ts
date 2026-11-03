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
 * the spacing left. A sibling with no dp height counts as 0, so the result is an upper bound when
 * one depends on layout. Hidden children (undefined) get no height.
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
 * A row, column or box with each child carrying the incoming max height it hands that child
 * (INCOMING_HEIGHT_KEY), where the node's own content height is statically known; other nodes
 * unchanged. A row or box hands every child its content height. A column measures its children
 * in order (see columnChildHeights), except a repeat, whose children are one template, so each
 * gets the whole content height as a bound. A height that depends on layout (a sibling's wrap
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
