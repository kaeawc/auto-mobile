import { record, type Raw } from "../prototypeTemplate";
import { ROW_MEASURE_KEY, type RowMeasure } from "./webStyle";

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
 * An `aspectRatio` node with no authored width, height, weight, or max bound. Compose's
 * `aspectRatio` sizes it from the incoming max width, so in a row it takes all the width its
 * earlier siblings left.
 */
export function isUnsizedAspectRatio(node: Raw | undefined): boolean {
  return freeAspectRatio(node) !== undefined && aspectRatioCap(node) === undefined;
}

/**
 * The widest a capped aspect ratio grows in a row: the tighter of its `maxWidth` and
 * `maxHeight × ratio`, or undefined when the node is not a capped, otherwise unsized aspect
 * ratio. Android applies `sizeIn` before `aspectRatio`, so the node takes
 * `min(remaining width, cap)` and may leave width for its later siblings.
 */
export function aspectRatioCap(node: Raw | undefined): number | undefined {
  const ratio = freeAspectRatio(node);
  const style = record(node?.style);
  if (ratio === undefined || !style) {
    return undefined;
  }
  const caps = [
    typeof style.maxWidth === "number" ? style.maxWidth : Infinity,
    typeof style.maxHeight === "number" ? style.maxHeight * ratio : Infinity,
  ];
  const cap = Math.min(...caps);
  return cap === Infinity ? undefined : cap;
}

/** A child as rendering will see it (bound, `styleWhen` merged), or undefined when it is hidden. */
export type PrepareChild = (entry: unknown, path: string) => Raw | undefined;

const childPath = (path: string, index: number) => `${path}.children[${index}]`;

/**
 * The axes a row grows on to its parent: width when its unsized aspect-ratio child takes all the
 * remaining width, since a wrap-sized Compose Row then reaches its max width.
 */
export function rowFillAxes(node: Raw, path: string, prepare: PrepareChild): "width"[] {
  const fills =
    node.type === "row" &&
    Array.isArray(node.children) &&
    node.children.some((entry, index) =>
      isUnsizedAspectRatio(prepare(entry, childPath(path, index))),
    );
  return fills ? ["width"] : [];
}

/**
 * A row's own CSS around a capped aspect-ratio child: a Compose Row never measures wider than its
 * parent, but the child's width (its cap) would grow a wrap-sized CSS row past it, so the row is
 * bounded to its parent's width and the cap shrinks inside it instead. An authored `maxWidth` wins.
 */
export function rowBoundCss(
  node: Raw,
  path: string,
  prepare: PrepareChild,
): Record<string, string> {
  const capped =
    node.type === "row" &&
    node.repeat === undefined &&
    Array.isArray(node.children) &&
    node.children.some((entry, index) => aspectRatioCap(prepare(entry, childPath(path, index))));
  return capped ? { "max-width": "100%" } : {};
}

/** A row with its children measured in order (see rowSequentialChildren); other nodes unchanged. */
export function rowMeasured(node: Raw, path: string, prepare: PrepareChild): Raw {
  if (node.type !== "row" || node.repeat !== undefined || !Array.isArray(node.children)) {
    return node;
  }
  const children = rowSequentialChildren(node.children, (entry, index) =>
    prepare(entry, childPath(path, index)),
  );
  return children === node.children ? node : { ...node, children };
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
 * CSS flex has no sequential measure, so the mapping zeroes those siblings (`maxWidth: 0`) and makes
 * the aspect-ratio child the row's lone grower (`weight: 1`, a zero flex basis). The earlier siblings
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
 * `prepared` resolves an entry as rendering will (bound, visible, `styleWhen` merged), or
 * undefined when it is hidden. A repeat's children are one template, so they are left as authored.
 */
export function rowSequentialChildren(
  entries: readonly unknown[],
  prepared: (entry: unknown, index: number) => Raw | undefined,
): readonly unknown[] {
  const styled = entries.map(prepared);
  const taker = styled.findIndex(isUnsizedAspectRatio);
  const capped = styled.findIndex((node) => aspectRatioCap(node) !== undefined);
  if (taker < 0 && capped < 0) {
    return entries;
  }
  return entries.map((entry, index) => {
    const node = styled[index];
    const weighted = typeof record(node?.style)?.weight === "number";
    if (!node || index === taker) {
      return node ? withStyle(entry, { weight: 1 }) : entry;
    }
    if (taker >= 0 && (index > taker || weighted)) {
      return withStyle(entry, { maxWidth: 0 });
    }
    if (capped < 0 || index < capped || weighted) {
      return entry;
    }
    const basis = aspectRatioCap(node);
    const shrink = index === capped ? CAPPED_SHRINK : LATER_SHRINK;
    return measured(entry, basis === undefined ? { shrink } : { shrink, basis });
  });
}
