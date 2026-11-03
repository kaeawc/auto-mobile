import { record, type Raw } from "../prototypeTemplate";

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
