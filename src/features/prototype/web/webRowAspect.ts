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

/**
 * What the row's sequential measure overrides on one child. It applies after the child's
 * `styleWhen` entries resolve, so an active conditional style cannot undo it; `css` applies over
 * the rendered element's own declarations.
 */
export interface RowChildOverride {
  readonly style: Raw;
  readonly css?: Readonly<Record<string, string>>;
}

/** The incoming constraints a row measures its children against, in dp. */
export interface RowBounds {
  /** The row's content height bound, when it is known (see contentHeightBound). */
  readonly height?: number;
  /** The screen width: no row's remaining width can exceed it. */
  readonly screenWidth: number;
}

const childPath = (path: string, index: number) => `${path}.children[${index}]`;

const dpOf = (value: unknown): number | undefined => {
  const dp = record(value)?.dp;
  return typeof dp === "number" ? dp : undefined;
};

/**
 * The height bound a container's content is measured against: its own `height` in dp or
 * `maxHeight`, capped by the bound it inherited (Compose constrains a wrap or fill node by its
 * parent's max height as well), less its vertical padding. Undefined when nothing bounds it.
 *
 * The inherited bound is the parent's whole content height. A column measures its children in
 * order, so a child after earlier siblings may in fact get less; the bound is an upper limit.
 */
export function contentHeightBound(
  style: unknown,
  inherited: number | undefined,
): number | undefined {
  const raw = record(style);
  const maxHeight = typeof raw?.maxHeight === "number" ? raw.maxHeight : undefined;
  const limits = [dpOf(raw?.height), maxHeight, inherited].filter(
    (value): value is number => value !== undefined,
  );
  if (limits.length === 0) {
    return undefined;
  }
  const padding = record(raw?.padding);
  const vertical = (["top", "bottom"] as const).reduce(
    (sum, side) => sum + (typeof padding?.[side] === "number" ? (padding[side] as number) : 0),
    0,
  );
  return Math.max(0, Math.min(...limits) - vertical);
}

/**
 * How Compose's `aspectRatio` (`matchHeightConstraintsFirst = false`) sizes an unsized node in a
 * row: the remaining width first, kept when the height it implies fits the row's height bound,
 * else the bound's height. The remaining width never exceeds the screen width, so a bounded row
 * whose bound allows a width of at least the screen always keeps the width; otherwise the node
 * takes `bound × ratio`, or the remaining width when less is left (which then fits the bound).
 */
function heightSized(node: Raw, bounds: RowBounds): number | undefined {
  const ratio = record(node.style)?.aspectRatio as number;
  const width = bounds.height === undefined ? undefined : bounds.height * ratio;
  return width !== undefined && width < bounds.screenWidth ? width : undefined;
}

/**
 * Per-child overrides, by index, for a row's children as Compose's `Row` measures them: each
 * unweighted child in order against the width the earlier ones left, then the weighted children
 * against what remains.
 *
 * An unsized aspect-ratio child sized from the row's height bound (see heightSized) takes
 * `bound × ratio` and may shrink to what is left, leaving its later siblings their width. The first
 * visible one sized from the width instead takes all the remaining width, so every later
 * unweighted child and every weighted child gets none.
 *
 * CSS flex has no sequential measure, so the mapping zeroes those siblings (`maxWidth: 0`) and makes
 * the width taker the row's lone grower (`weight: 1`, a zero flex basis). The earlier siblings keep
 * their content width, and the grower takes the rest. Three cases still differ: the row's
 * `spacing` still separates the zeroed siblings, which Compose drops once no width is left; an
 * earlier `fill` sibling shares the remaining width instead of taking all of it; and when less
 * than `bound × ratio` is left, a height-sized child shares the shortfall with its later siblings
 * instead of taking all that is left.
 *
 * `prepared` resolves an entry as rendering will (bound, visible, `styleWhen` merged), or
 * undefined when it is hidden.
 */
export function rowChildOverrides(
  entries: readonly unknown[],
  prepared: (entry: unknown, index: number) => Raw | undefined,
  bounds: RowBounds,
): ReadonlyMap<number, RowChildOverride> {
  const styled = entries.map(prepared);
  // Each unsized aspect ratio's height-sized width, or "rest" when it takes the remaining width.
  const sizing = styled.map((node) =>
    node && isUnsizedAspectRatio(node) ? (heightSized(node, bounds) ?? "rest") : undefined,
  );
  const taker = sizing.indexOf("rest");
  const overrides = new Map<number, RowChildOverride>();
  for (const [index, node] of styled.entries()) {
    const override = node && measuredOverride(node, index, sizing[index], taker);
    if (override) {
      overrides.set(index, override);
    }
  }
  return overrides;
}

/** One visible child's override (see rowChildOverrides), given the width taker's index or -1. */
function measuredOverride(
  node: Raw,
  index: number,
  sizing: number | "rest" | undefined,
  taker: number,
): RowChildOverride | undefined {
  if (index === taker) {
    return { style: { weight: 1 } };
  }
  // Weighted children measure after every unweighted one, so they get none wherever they sit.
  if (taker >= 0 && (index > taker || typeof record(node.style)?.weight === "number")) {
    return { style: { maxWidth: 0 } };
  }
  // Sized from the height, it keeps its own width and shrinks only when less is left, where the
  // width-first try then fits.
  return typeof sizing === "number"
    ? {
        style: { width: { dp: Number(sizing.toFixed(3)) } },
        css: { "flex-shrink": "1", "min-width": "0" },
      }
    : undefined;
}

/** Whether one of a row's children takes all the remaining width (see rowChildOverrides). */
function takesRemainingWidth(node: Raw, path: string, prepare: PrepareChild, bounds: RowBounds) {
  return (
    Array.isArray(node.children) &&
    node.children.some((entry, index) => {
      const child = prepare(entry, childPath(path, index));
      return child !== undefined && isUnsizedAspectRatio(child) && !heightSized(child, bounds);
    })
  );
}

/**
 * The axes a row grows on to its parent: width when an unsized aspect-ratio child takes all the
 * remaining width, since a wrap-sized Compose Row then reaches its max width.
 */
export function rowFillAxes(
  node: Raw,
  path: string,
  prepare: PrepareChild,
  bounds: RowBounds,
): "width"[] {
  return node.type === "row" && takesRemainingWidth(node, path, prepare, bounds) ? ["width"] : [];
}

/**
 * A row's per-child overrides keyed by child path (see rowChildOverrides); none for other nodes.
 * A repeat's children are one template, so they are left as authored.
 */
export function rowMeasured(
  node: Raw,
  path: string,
  prepare: PrepareChild,
  bounds: RowBounds,
): ReadonlyMap<string, RowChildOverride> {
  if (node.type !== "row" || node.repeat !== undefined || !Array.isArray(node.children)) {
    return new Map();
  }
  const byIndex = rowChildOverrides(
    node.children,
    (entry, index) => prepare(entry, childPath(path, index)),
    bounds,
  );
  return new Map([...byIndex].map(([index, override]) => [childPath(path, index), override]));
}

/**
 * The row's own CSS for its measured children: a height-sized child shrinks only inside a row
 * capped at its parent's width, as a Compose Row's incoming max width caps it. A wrap-sized flex
 * row would otherwise grow past its parent around that child's width. An authored `maxWidth`
 * keeps its own cap.
 */
export function rowCapCss(
  node: Raw,
  overrides: ReadonlyMap<string, RowChildOverride>,
): Readonly<Record<string, string>> {
  const shrinks = [...overrides.values()].some((override) => override.css !== undefined);
  return shrinks && typeof record(node.style)?.maxWidth !== "number" ? { "max-width": "100%" } : {};
}
