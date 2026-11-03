import { record, type Raw } from "../prototypeTemplate";
import { INCOMING_HEIGHT_KEY, type WebStyleContext } from "./webStyle";

/**
 * An `aspectRatio` node with no authored width, height, weight, or max bound. Compose's
 * `aspectRatio` sizes it from the incoming max width, so in a row it takes all the width its
 * earlier siblings left. A `maxWidth` or `maxHeight` is applied before the ratio (`sizeIn`), so a
 * capped node may leave width for later siblings; it keeps plain `aspect-ratio` instead.
 */
export function isUnsizedAspectRatio(node: Raw | undefined): boolean {
  const style = record(node?.style);
  return (
    typeof style?.aspectRatio === "number" &&
    style.aspectRatio > 0 &&
    style.width === undefined &&
    style.height === undefined &&
    typeof style.weight !== "number" &&
    typeof style.maxWidth !== "number" &&
    typeof style.maxHeight !== "number"
  );
}

/** A child as rendering will see it (bound, `styleWhen` merged), or undefined when it is hidden. */
export type PrepareChild = (entry: unknown, path: string) => Raw | undefined;

const childPath = (path: string, index: number) => `${path}.children[${index}]`;

/** How the row is measured: under a horizontal scroll its incoming width is unbounded. */
export interface RowMeasure {
  readonly unboundedWidth?: boolean;
}

const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : Infinity;

const side = (padding: Raw | undefined, name: string): number =>
  typeof padding?.[name] === "number" ? padding[name] : 0;

/**
 * The tallest a node lets its children be: its dp `height` held under its `maxHeight` and the
 * height its parent hands it (INCOMING_HEIGHT_KEY), raised to its `minHeight`, less its vertical
 * padding. Infinity when no bound is statically known (a wrap-sized or `fill` node with no
 * handed height).
 */
export function rowContentHeight(style: Raw | undefined): number {
  const own = Math.min(
    finite(record(style?.height)?.dp),
    finite(style?.maxHeight),
    finite(style?.[INCOMING_HEIGHT_KEY]),
  );
  const floor = typeof style?.minHeight === "number" ? style.minHeight : 0;
  const bound = Math.max(floor, own);
  const padding = record(style?.padding);
  return Math.max(0, bound - side(padding, "top") - side(padding, "bottom"));
}

/**
 * The axes a row grows on to its parent: width when its unsized aspect-ratio child takes all the
 * remaining width, since a wrap-sized Compose Row then reaches its max width. Under an unbounded
 * width there is no max width to reach, and the child sizes from the height instead.
 */
export function rowFillAxes(
  node: Raw,
  path: string,
  prepare: PrepareChild,
  measure: RowMeasure = {},
): "width"[] {
  const fills =
    node.type === "row" &&
    measure.unboundedWidth !== true &&
    Array.isArray(node.children) &&
    node.children.some((entry, index) =>
      isUnsizedAspectRatio(prepare(entry, childPath(path, index))),
    );
  return fills ? ["width"] : [];
}

/**
 * A row with its children measured in order (see rowSequentialChildren), or by the height under
 * an unbounded width (see rowHeightSizedChildren, withChildHeights); other nodes unchanged.
 */
export function rowMeasured(
  node: Raw,
  path: string,
  prepare: PrepareChild,
  measure: RowMeasure = {},
): Raw {
  if (node.type !== "row" || node.repeat !== undefined || !Array.isArray(node.children)) {
    return node;
  }
  const prepared = (entry: unknown, index: number) => prepare(entry, childPath(path, index));
  const children =
    measure.unboundedWidth === true
      ? rowHeightSizedChildren(node.children, prepared, rowContentHeight(record(node.style)))
      : rowSequentialChildren(node.children, prepared);
  return withChildHeights(children === node.children ? node : { ...node, children }, measure);
}

function withStyle(entry: unknown, patch: Raw): unknown {
  const node = record(entry);
  return node ? { ...node, style: { ...record(node.style), ...patch } } : entry;
}

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
 * `prepared` resolves an entry as rendering will (bound, visible, `styleWhen` merged), or
 * undefined when it is hidden. A repeat's children are one template, so they are left as authored.
 */
export function rowSequentialChildren(
  entries: readonly unknown[],
  prepared: (entry: unknown, index: number) => Raw | undefined,
): readonly unknown[] {
  const styled = entries.map(prepared);
  const taker = styled.findIndex(isUnsizedAspectRatio);
  if (taker < 0) {
    return entries;
  }
  return entries.map((entry, index) => {
    const node = styled[index];
    if (index === taker) {
      return withStyle(entry, { weight: 1 });
    }
    const weighted = typeof record(node?.style)?.weight === "number";
    return node && (index > taker || weighted) ? withStyle(entry, { maxWidth: 0 }) : entry;
  });
}

/**
 * A row's children as Compose's `Row` measures them against an unbounded width (under a horizontal
 * scroll): an unsized aspect-ratio child cannot size from the width, so it sizes from the incoming
 * max height, `height × ratio` wide, and its later siblings keep their width. With the row's
 * content height `height` (see rowContentHeight) known, each such child gets that size; with no
 * definite height the children stay as authored. No child takes the remaining width, since none
 * is left to take.
 */
export function rowHeightSizedChildren(
  entries: readonly unknown[],
  prepared: (entry: unknown, index: number) => Raw | undefined,
  height: number,
): readonly unknown[] {
  if (!Number.isFinite(height)) {
    return entries;
  }
  const sized = entries.map((entry, index) => {
    const node = prepared(entry, index);
    const ratio = record(node?.style)?.aspectRatio;
    return isUnsizedAspectRatio(node) && typeof ratio === "number"
      ? withStyle(entry, { width: { dp: height * ratio }, height: { dp: height } })
      : entry;
  });
  return sized.some((entry, index) => entry !== entries[index]) ? sized : entries;
}

/**
 * A child with its parent's definite content height handed to it (INCOMING_HEIGHT_KEY), as
 * Compose's incoming max height; unchanged when that height depends on layout. A horizontal
 * scroll hands it to its child; a vertical scroll hands its child an unbounded height instead.
 */
function withIncomingHeight(entry: unknown, parentStyle: unknown): unknown {
  const node = record(entry);
  const height = rowContentHeight(record(parentStyle));
  return node && Number.isFinite(height)
    ? { ...node, style: { ...record(node.style), [INCOMING_HEIGHT_KEY]: height } }
    : entry;
}

/**
 * A container under an unbounded width with each child handed its own content height (see
 * rowContentHeight) as INCOMING_HEIGHT_KEY, as Compose passes the max height on: a horizontal
 * scroll to its child, and a row or box to every child, so a row nested in them still sizes its
 * aspect ratios from the scroll's height. Other nodes, and nodes whose content height depends on
 * layout, are unchanged. A column is left out: each child's bound there depends on its earlier
 * siblings' heights.
 */
export function withChildHeights(node: Raw, measure: RowMeasure): Raw {
  const style = record(node.style);
  if (measure.unboundedWidth !== true || !Number.isFinite(rowContentHeight(style))) {
    return node;
  }
  if (node.type === "scroll") {
    return node.child === undefined
      ? node
      : { ...node, child: withIncomingHeight(node.child, style) };
  }
  const passes = node.type === "row" || node.type === "box";
  return passes && Array.isArray(node.children)
    ? { ...node, children: node.children.map((entry) => withIncomingHeight(entry, style)) }
    : node;
}

/**
 * The style context a node's descendants see: a node that bounds its own width (a dp `width` or a
 * `maxWidth`) hands its content a finite max width again, even under a horizontal scroll.
 */
export function widthBoundContext(style: WebStyleContext, own: unknown): WebStyleContext {
  const authored = record(own);
  const bounded =
    typeof record(authored?.width)?.dp === "number" || typeof authored?.maxWidth === "number";
  return bounded && style.unboundedWidth === true ? { ...style, unboundedWidth: false } : style;
}
