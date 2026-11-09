import { record, type Raw } from "../prototypeTemplate";
import {
  INCOMING_ALLOCATED_KEY,
  INCOMING_HEIGHT_KEY,
  ROW_BOUND_KEY,
  ROW_MEASURE_KEY,
  type RowMeasure,
  scrollChildStyle,
  type WebStyleContext,
} from "./webStyle";

/** The aspect ratio of a node with no authored width, height or weight, or undefined. */
function freeAspectRatio(node: Raw | undefined): number | undefined {
  const style = record(node?.style);
  if (!style || typeof style.aspectRatio !== "number" || style.aspectRatio <= 0) {
    return undefined;
  }
  const sized =
    style.width !== undefined || style.height !== undefined || typeof style.weight === "number";
  return sized ? undefined : style.aspectRatio;
}

/**
 * An `aspectRatio` node with no authored width, height, weight, or max bound, in a row with no
 * definite height (`rowHeight`). Compose's `aspectRatio` sizes it from the incoming max width, so
 * in a row it takes all the width its earlier siblings left.
 */
export function isUnsizedAspectRatio(node: Raw | undefined, rowHeight = Infinity): boolean {
  return freeAspectRatio(node) !== undefined && aspectRatioCap(node, rowHeight) === undefined;
}

/**
 * The widest a capped aspect ratio grows in a row: the tightest of its `maxWidth`, its
 * `maxHeight × ratio` and the row's content height (`rowHeight`) × ratio, or undefined when the node is not a capped, otherwise unsized aspect
 * ratio. Android applies `sizeIn` before `aspectRatio`, so the node takes
 * `min(remaining width, cap)` and may leave width for its later siblings.
 */
export function aspectRatioCap(node: Raw | undefined, rowHeight = Infinity): number | undefined {
  const ratio = freeAspectRatio(node);
  const style = record(node?.style);
  if (ratio === undefined || !style) {
    return undefined;
  }
  const caps = [
    typeof style.maxWidth === "number" ? style.maxWidth : Infinity,
    typeof style.maxHeight === "number" ? style.maxHeight * ratio : Infinity,
    rowHeight * ratio,
  ];
  const cap = Math.min(...caps);
  return cap === Infinity ? undefined : cap;
}

/** A child as rendering will see it (bound, `styleWhen` merged), or undefined when it is hidden. */
export type PrepareChild = (entry: unknown, path: string) => Raw | undefined;

const childPath = (path: string, index: number) => `${path}.children[${index}]`;

const side = (padding: Raw | undefined, name: string) =>
  typeof padding?.[name] === "number" ? padding[name] : 0;

/**
 * The height a node's own size takes, as CSS and Compose's `sizeIn` then `height` resolve it: its
 * dp `height` (else unbounded) held under `maxHeight`, then raised to `minHeight`, which wins.
 */
export function ownHeight(style: Raw | undefined): number {
  const dp = record(style?.height)?.dp;
  return clampedHeight(style, typeof dp === "number" ? dp : Infinity);
}

/** `height` held under the node's `maxHeight`, then raised to its `minHeight`, which wins. */
function clampedHeight(style: Raw | undefined, height: number): number {
  const max = typeof style?.maxHeight === "number" ? style.maxHeight : Infinity;
  const min = typeof style?.minHeight === "number" ? style.minHeight : 0;
  return Math.max(Math.min(height, max), min);
}

/**
 * The tallest a row or box lets its children be: its dp `height` (coerced into its `minHeight`, as
 * `sizeIn` applies before the height) or its `maxHeight`, capped by the bound it inherited from a
 * row, column or box ancestor (`inherited`; Compose constrains a wrap or fill node by its parent's
 * max height too) and by the share a column hands it (INCOMING_HEIGHT_KEY), less its vertical
 * padding. Compose's `sizeIn` then `aspectRatio` on a child
 * respects that incoming max height. Infinity when nothing bounds it.
 *
 * A column's exact weight allocation (INCOMING_ALLOCATED_KEY) instead sizes the node outright,
 * whatever its dp height and height bounds, as Compose's fixed weight constraints and SwiftUI's
 * weighted axis pin it; CSS's `flex: w w 0` replaces its `height`, and the renderer drops its
 * main-axis min/max bounds (see sizeStyle).
 *
 * The inherited bound is the parent's whole content height; a column narrows it per child to
 * what its earlier siblings left (see webIncomingHeight.ts).
 */
export function rowContentHeight(style: Raw | undefined, inherited = Infinity): number {
  const own = ownHeight(style);
  const padding = record(style?.padding);
  const incoming = style?.[INCOMING_HEIGHT_KEY];
  const handed = typeof incoming === "number" ? incoming : Infinity;
  const allocated = style?.[INCOMING_ALLOCATED_KEY] === true && handed !== Infinity;
  const height = allocated ? handed : Math.min(own, inherited, handed);
  return Math.max(0, height - side(padding, "top") - side(padding, "bottom"));
}

/**
 * What a scroll's child scope sees: its style context (see scrollChildStyle) and, across, the
 * scroll's content height as its height bound, since Compose measures horizontal scroll content
 * against the scroll's max height. A vertical scroll hands its content an unbounded height.
 */
export function scrollChildPatch(
  scope: { readonly style: WebStyleContext; readonly heightBound?: number },
  node: Raw,
) {
  const across = node.axis === "horizontal";
  const heightBound = across ? contentHeightBound(node.style, scope.heightBound) : undefined;
  return { inBox: false, style: scrollChildStyle(scope, node), heightBound };
}

/** The content height bound a row or box passes its children (see rowContentHeight), if any. */
export function contentHeightBound(style: unknown, inherited?: number): number | undefined {
  const bound = rowContentHeight(record(style), inherited ?? Infinity);
  return bound === Infinity ? undefined : bound;
}

/**
 * What bounds a row from outside, as a render scope carries it: the content height its parent
 * passes on (`heightBound`, see rowContentHeight) and whether its incoming max width is unbounded,
 * as under a horizontal scroll (`style.unboundedWidth`). A bare number is the height alone.
 */
export interface RowBounds {
  readonly heightBound?: number;
  readonly style?: { readonly unboundedWidth?: boolean };
}

const rowBounds = (bounds: number | RowBounds) =>
  typeof bounds === "number"
    ? { height: bounds, unboundedWidth: false }
    : { height: bounds.heightBound, unboundedWidth: bounds.style?.unboundedWidth === true };

/**
 * The axes a row grows on to its parent: width when its unsized aspect-ratio child takes all the
 * remaining width, since a wrap-sized Compose Row then reaches its max width. A repeated row is
 * left out, as rowMeasured leaves it: its children never get the take and zero hints the fill
 * assumes. Under an unbounded width (a horizontal scroll) there is no max width to reach.
 */
export function rowFillAxes(
  node: Raw,
  path: string,
  prepare: PrepareChild,
  bounds: number | RowBounds = Infinity,
): "width"[] {
  const { height: inherited = Infinity, unboundedWidth } = rowBounds(bounds);
  const fills =
    node.type === "row" &&
    node.repeat === undefined &&
    unboundedWidth !== true &&
    Array.isArray(node.children) &&
    node.children.some((entry, index) =>
      isUnsizedAspectRatio(
        prepare(entry, childPath(path, index)),
        rowContentHeight(record(node.style), inherited),
      ),
    );
  return fills ? ["width"] : [];
}

/**
 * A row with its children measured in order (see rowSequentialChildren); other nodes unchanged.
 * Around a capped aspect ratio the row is also bounded to its parent's width (ROW_BOUND_KEY): a
 * Compose Row never measures wider than its max, but the child's width (its cap) would grow a
 * wrap-sized CSS row past it, so the cap shrinks inside the row instead.
 */
export function rowMeasured(
  node: Raw,
  path: string,
  prepare: PrepareChild,
  bounds: number | RowBounds = Infinity,
): Raw {
  if (node.type !== "row" || node.repeat !== undefined || !Array.isArray(node.children)) {
    return node;
  }
  const { height: inherited = Infinity, unboundedWidth } = rowBounds(bounds);
  const styled = node.children.map((entry, index) => prepare(entry, childPath(path, index)));
  const height = rowContentHeight(record(node.style), inherited);
  const children = rowSequentialChildren(
    node.children,
    (_entry, index) => styled[index],
    height,
    unboundedWidth,
  );
  if (children === node.children) {
    return node;
  }
  const bounded = styled.some((child) => aspectRatioCap(child, height) !== undefined);
  const style = bounded ? { ...record(node.style), [ROW_BOUND_KEY]: true } : node.style;
  return { ...node, children, ...(style === undefined ? {} : { style }) };
}

function withStyle(entry: unknown, patch: Raw): unknown {
  const node = record(entry);
  return node ? { ...node, style: { ...record(node.style), ...patch } } : entry;
}

/**
 * Flex shrink tiers for a capped aspect ratio's row. CSS flex shrinks every item at once, in
 * proportion to shrink × basis, where Compose's Row measures in order and the last child loses its
 * width first. Tiers far apart make the later siblings give up their width first (down to zero),
 * then the capped child, then the earlier siblings (shrink 1), as the sequential measure does.
 */
export const CAPPED_SHRINK = 1_000;
export const LATER_SHRINK = 1_000_000_000;

const measured = (entry: unknown, measure: RowMeasure) =>
  withStyle(entry, { [ROW_MEASURE_KEY]: measure });

/**
 * A row's children as Compose's `Row` measures them: each unweighted child in order against the
 * width the earlier ones left, then the weighted children against what remains. The first visible
 * unsized aspect-ratio child therefore takes all the remaining width, and every later unweighted
 * child and every weighted child gets none.
 *
 * CSS flex has no sequential measure, so the mapping zeroes those siblings (`max-width: 0`) and makes
 * the aspect-ratio child the row's lone grower (`flex: 1 1 0`). The earlier siblings
 * keep their content width, and the grower takes the rest. Two cases still differ: the row's
 * `spacing` still separates the zeroed siblings, which Compose drops once no width is left, and an
 * earlier `fill` sibling shares the remaining width instead of taking all of it.
 *
 * A capped aspect ratio (see aspectRatioCap) before any unsized one takes `min(remaining, cap)`: it
 * gets its cap as a flex basis, and it and every later unweighted sibling get a shrink tier, so the
 * later siblings keep their width while the cap leaves room and lose it first when it does not.
 * Weighted siblings keep their zero basis and grow into whatever is left. Later siblings share a
 * tier, so a shortfall is split across them by width rather than taken from the last one first.
 *
 * Every hint goes through ROW_MEASURE_KEY, which no `styleWhen` can author, so a conditional
 * `maxWidth` or `weight` that rendering merges again cannot undo it.
 *
 * `rowHeight` is the row's definite content height (see rowContentHeight), which caps every
 * aspect ratio in it as a `maxHeight` would.
 *
 * Under an unbounded width (`unboundedWidth`, a horizontal scroll) there is no remaining width to
 * take: Compose's `aspectRatio` sizes from the incoming max height instead, which `rowHeight`
 * already caps, and with no definite height an unsized ratio stays as authored, so nothing is
 * zeroed.
 *
 * `prepared` resolves an entry as rendering will (bound, visible, `styleWhen` merged), or
 * undefined when it is hidden. A repeat's children are one template, so they are left as authored.
 */
export function rowSequentialChildren(
  entries: readonly unknown[],
  prepared: (entry: unknown, index: number) => Raw | undefined,
  rowHeight = Infinity,
  unboundedWidth = false,
): readonly unknown[] {
  const styled = entries.map(prepared);
  const taker = unboundedWidth
    ? -1
    : styled.findIndex((node) => isUnsizedAspectRatio(node, rowHeight));
  const capped = styled.findIndex((node) => aspectRatioCap(node, rowHeight) !== undefined);
  if (taker < 0 && capped < 0) {
    return entries;
  }
  return entries.map((entry, index) => {
    const node = styled[index];
    if (!node) {
      return entry;
    }
    if (index === taker) {
      return measured(entry, { take: true });
    }
    const weighted = typeof record(node.style)?.weight === "number";
    if (taker >= 0 && (index > taker || weighted)) {
      return measured(entry, { zero: true });
    }
    return capped < 0 || index < capped || weighted
      ? entry
      : cappedSibling(entry, aspectRatioCap(node, rowHeight), index === capped);
  });
}

/**
 * The capped aspect ratio itself, or a later unweighted sibling, with its shrink tier. A later
 * sibling is marked `later`, so its authored `minWidth` holds only while width remains.
 */
function cappedSibling(entry: unknown, basis: number | undefined, first: boolean): unknown {
  const tier: RowMeasure = first
    ? { shrink: CAPPED_SHRINK }
    : { shrink: LATER_SHRINK, later: true };
  return measured(entry, basis === undefined ? tier : { ...tier, basis });
}
