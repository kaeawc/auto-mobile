import { expect, test } from "bun:test";
import { record, type Raw } from "../../../../src/features/prototype/prototypeTemplate";
import {
  columnChildHeights,
  exactWeightShares,
  repeatInstanceChildren,
  withColumnHeights,
} from "../../../../src/features/prototype/web/webIncomingHeight";
import {
  CAPPED_SHRINK,
  rowContentHeight,
  rowMeasured,
  type PrepareChild,
} from "../../../../src/features/prototype/web/webRowAspect";
import {
  INCOMING_ALLOCATED_KEY,
  INCOMING_HEIGHT_KEY,
  nodeCss,
  ROW_BOUND_KEY,
  ROW_MEASURE_KEY,
} from "../../../../src/features/prototype/web/webStyle";

const prepare = (entry: unknown) => record(entry);
const heightOf = (entry: unknown) => record(record(entry)?.style)?.[INCOMING_HEIGHT_KEY];
const childrenOf = (node: Raw) => node.children as unknown[];

test("a node's content height is also bounded by the share its column hands it", () => {
  expect(rowContentHeight({ minHeight: 30, [INCOMING_HEIGHT_KEY]: 40 })).toBe(40);
  // A fill, weighted or wrap node is bounded by what its parent hands it.
  expect(rowContentHeight({ height: "fill", [INCOMING_HEIGHT_KEY]: 40 })).toBe(40);
  expect(rowContentHeight({ weight: 1, [INCOMING_HEIGHT_KEY]: 30, padding: { top: 5 } })).toBe(25);
  expect(rowContentHeight({ height: { dp: 80 }, [INCOMING_HEIGHT_KEY]: 40 })).toBe(40);
  expect(rowContentHeight({ [INCOMING_HEIGHT_KEY]: 40 }, 30)).toBe(30);
});

test("a column hands each child what its earlier siblings left, and weights share the rest", () => {
  const dp = (height: number) => ({ type: "box", style: { height: { dp: height } } });
  const weighted = (weight: number) => ({ type: "row", style: { weight } });
  expect(columnChildHeights([dp(10), dp(20), { type: "row" }], 100, 0)).toEqual([100, 90, 70]);
  expect(columnChildHeights([dp(10), weighted(1), weighted(3), dp(10)], 100, 0)).toEqual([
    100, 20, 60, 90,
  ]);
  // Spacing separates visible children only; a hidden child gets nothing and takes nothing.
  expect(columnChildHeights([dp(10), undefined, weighted(1)], 100, 8)).toEqual([
    100,
    undefined,
    82,
  ]);
  // A sibling takes its dp height clamped by its own bounds.
  const clamped = { type: "box", style: { height: { dp: 100 }, maxHeight: 20 } };
  expect(columnChildHeights([clamped, weighted(1)], 100, 0)).toEqual([100, 80]);
  // A wrap sibling's maxHeight is not height it takes.
  const wrapped = { type: "box", style: { maxHeight: 100 } };
  expect(columnChildHeights([wrapped, weighted(1)], 100, 0)).toEqual([100, 100]);
  const floored = { type: "text", style: { minHeight: 30 } };
  expect(columnChildHeights([floored, weighted(1)], 100, 0)).toEqual([100, 70]);
  // A sibling with no dp height counts as 0, so the bound is an upper one.
  expect(columnChildHeights([{ type: "text" }, weighted(1)], 40, 0)).toEqual([40, 40]);
  expect(columnChildHeights([dp(50), weighted(1)], 40, 0)).toEqual([40, 0]);
});

test("a fill sibling takes what is left, so later siblings and weights get none (#16694)", () => {
  const fill = { type: "row", style: { height: "fill" } };
  const weighted = { type: "row", style: { weight: 1 } };
  const dp = (height: number) => ({ type: "box", style: { height: { dp: height } } });
  // As Compose's Column measures fillMaxHeight: it takes what its earlier siblings left.
  expect(columnChildHeights([dp(10), fill, weighted], 40, 0)).toEqual([40, 30, 0]);
  expect(columnChildHeights([fill, dp(10)], 40, 0)).toEqual([40, 0]);
  // A weighted sibling before the fill gets none either: the fill was measured first.
  expect(columnChildHeights([weighted, fill], 40, 4)).toEqual([0, 40]);
  // A fill held under its maxHeight takes only that, and leaves the rest.
  const capped = { type: "row", style: { height: "fill", maxHeight: 15 } };
  expect(columnChildHeights([capped, weighted], 40, 5)).toEqual([40, 20]);
});

test("a repeat column hands each instance its own share of the column's height (#16694)", () => {
  const prepares = [prepare, prepare];
  const weighted = {
    type: "column",
    repeat: { items: [{}, {}] },
    children: [{ type: "row", style: { weight: 1 } }],
  };
  const heights = (node: Raw, list: readonly PrepareChild[], content: number) =>
    repeatInstanceChildren(node, "root", list, content).map((each) => each.map(heightOf));
  // Two weighted instances in a 40 dp column get 20 dp each, as on Android.
  expect(heights(weighted, prepares, 40)).toEqual([[20], [20]]);
  // Unweighted instances are measured in order, across instances, with the spacing between; the
  // wrap row counts as 0, so its bound is an upper one.
  const sequential = {
    ...weighted,
    style: { spacing: 2 },
    children: [{ type: "box", style: { height: { dp: 10 } } }, { type: "row" }],
  };
  expect(heights(sequential, prepares, 40)).toEqual([
    [40, 28],
    [26, 14],
  ]);
  // A child hidden in one instance takes nothing there, not even spacing.
  const hiddenFirst = (entry: unknown, path: string) =>
    path.endsWith("[0]") ? undefined : prepare(entry);
  expect(heights(sequential, [hiddenFirst, prepare], 40)).toEqual([
    [undefined, 40],
    [38, 26],
  ]);
});

test("a repeat that is not a bounded column keeps its template for every instance", () => {
  const children = [{ type: "row", style: { weight: 1 } }];
  const column = { type: "column", repeat: { items: [{}] }, children };
  expect(repeatInstanceChildren(column, "root", [prepare], undefined)).toEqual([children]);
  const row = { type: "row", repeat: { items: [{}] }, children };
  expect(repeatInstanceChildren(row, "root", [prepare, prepare], 40)).toEqual([children, children]);
  expect(repeatInstanceChildren({ type: "column", children }, "root", [prepare], 40)).toEqual([
    children,
  ]);
  expect(repeatInstanceChildren(column, "root", [], 40)).toEqual([]);
});

test("a column with a known content height passes it down sequentially", () => {
  const column = {
    type: "column",
    children: [{ type: "box", style: { height: { dp: 10 } } }, { type: "row" }],
  };
  expect(childrenOf(withColumnHeights(column, "root", prepare, 40)).map(heightOf)).toEqual([
    40, 30,
  ]);
});

test("a repeat column, a row, a box or an unbounded column leaves its children as authored", () => {
  const children = [{ type: "box", style: { height: { dp: 10 } } }, { type: "row" }];
  const repeated = { type: "column", repeat: { items: [] }, children };
  expect(withColumnHeights(repeated, "root", prepare, 40)).toBe(repeated);
  for (const type of ["row", "box", "scroll"]) {
    const node = { type, children };
    expect(withColumnHeights(node, "root", prepare, 40)).toBe(node);
  }
  const wrap = { type: "column", children };
  expect(withColumnHeights(wrap, "root", prepare, undefined)).toBe(wrap);
  // The key is internal: it never reaches the CSS.
  const css = nodeCss({ [INCOMING_HEIGHT_KEY]: 40 }, { mode: "light", palette: new Map() });
  expect(css).toEqual({ "box-sizing": "border-box" });
});

test("a fill-height row below a 60 dp sibling in a 100 dp column caps its ratio at 40 dp", () => {
  const column = withColumnHeights(
    {
      type: "column",
      children: [
        { type: "box", style: { height: { dp: 60 } } },
        {
          type: "row",
          style: { height: "fill" },
          children: [{ type: "box", style: { aspectRatio: 2 } }, { type: "text" }],
        },
      ],
    },
    "root",
    prepare,
    100,
  );
  const row = record(childrenOf(column)[1])!;
  const ratio = childrenOf(rowMeasured(row, "root.children[1]", prepare, 100))[0];
  expect(record(record(ratio)?.style)?.[ROW_MEASURE_KEY]).toEqual({
    shrink: CAPPED_SHRINK,
    basis: 80,
  });
});

test("a card hands its children heights as a column does, with no spacing (#16690)", () => {
  const card = withColumnHeights(
    {
      type: "card",
      style: { spacing: 8 },
      children: [
        { type: "box", style: { height: { dp: 20 } } },
        { type: "row", style: { weight: 1 } },
      ],
    },
    "root",
    prepare,
    80,
  );
  // 80 dp of content: the box gets all of it, the weighted row what the box left; a card's
  // children are not spaced, so `spacing` takes nothing.
  expect(childrenOf(card).map(heightOf)).toEqual([80, 60]);
  // An unbounded card hands nothing down.
  const loose = { type: "card", children: [{ type: "row" }] };
  expect(withColumnHeights(loose, "root", prepare, undefined)).toBe(loose);
});

test("only a column or card narrows its children a height (#16690)", () => {
  const node = { type: "toString", style: { height: { dp: 50 } }, children: [{ type: "row" }] };
  expect(withColumnHeights(node, "root", prepare, 50)).toBe(node);
});

test("a column's weight allocation sizes a child past its own dp height (#16701)", () => {
  const allocated = { [INCOMING_HEIGHT_KEY]: 80, [INCOMING_ALLOCATED_KEY]: true };
  expect(rowContentHeight({ ...allocated, weight: 1, height: { dp: 20 } })).toBe(80);
  // Both devices pin a weighted axis to its share, so its height bounds do not clamp it (#16698).
  expect(rowContentHeight({ ...allocated, weight: 1, maxHeight: 50, padding: { top: 5 } })).toBe(
    75,
  );
  expect(rowContentHeight({ ...allocated, weight: 1, minHeight: 100 })).toBe(80);
  expect(rowContentHeight({ ...allocated, weight: 1, minHeight: 100, maxHeight: 50 })).toBe(80);
  // Without the mark, the incoming height is a ceiling the child's own height can undercut.
  expect(rowContentHeight({ [INCOMING_HEIGHT_KEY]: 80, weight: 1, height: { dp: 20 } })).toBe(20);
  // A mark with no incoming height bounds nothing.
  expect(rowContentHeight({ [INCOMING_ALLOCATED_KEY]: true, height: { dp: 20 } })).toBe(20);
});

test("a weighted row with a dp height in a 100 dp column caps its aspect ratio by its share (#16701)", () => {
  const column = withColumnHeights(
    {
      type: "column",
      children: [
        { type: "box", style: { height: { dp: 20 } } },
        {
          type: "row",
          style: { weight: 1, height: { dp: 20 } },
          children: [{ type: "box", style: { aspectRatio: 2 } }, { type: "text" }],
        },
      ],
    },
    "root",
    prepare,
    100,
  );
  const [box, row] = childrenOf(column).map((entry) => record(record(entry)?.style));
  expect(box?.[INCOMING_ALLOCATED_KEY]).toBeUndefined();
  expect(row?.[INCOMING_ALLOCATED_KEY]).toBe(true);
  const ratio = childrenOf(
    rowMeasured(record(childrenOf(column)[1])!, "root.children[1]", prepare, 100),
  );
  expect(record(record(ratio[0])?.style)?.[ROW_MEASURE_KEY]).toEqual({
    shrink: CAPPED_SHRINK,
    basis: 160,
  });
});

test("only a weighted child of a column, card or repeat column is marked as allocated (#16701)", () => {
  const children = [
    { type: "box", style: { height: { dp: 10 } } },
    { type: "row", style: { weight: 1, height: { dp: 20 } } },
  ];
  const allocatedOf = (entries: readonly unknown[]) =>
    entries.map((entry) => record(record(entry)?.style)?.[INCOMING_ALLOCATED_KEY]);
  const marks = (type: string) =>
    allocatedOf(childrenOf(withColumnHeights({ type, children }, "root", prepare, 100)));
  expect(marks("column")).toEqual([undefined, true]);
  expect(marks("card")).toEqual([undefined, true]);
  // A repeat column hands each instance its own share, so its weighted instances are allocations.
  const repeat = { type: "column", repeat: { items: [{}, {}] }, children };
  expect(repeatInstanceChildren(repeat, "root", [prepare, prepare], 100).map(allocatedOf)).toEqual([
    [undefined, true],
    [undefined, true],
  ]);
  // The key is internal: it never reaches the CSS.
  const css = nodeCss({ [INCOMING_ALLOCATED_KEY]: true }, { mode: "light", palette: new Map() });
  expect(css).toEqual({ "box-sizing": "border-box" });
});

const light = { mode: "light", palette: new Map() } as const;

test("a weight drops the authored bounds on its main axis, as both devices pin it to its share (#16698)", () => {
  const bounds = { minWidth: 10, maxWidth: 20, minHeight: 30, maxHeight: 40 };
  const inColumn = nodeCss(
    { weight: 1, height: { dp: 10 }, ...bounds },
    { ...light, parentAxis: "column", weightsChildren: true },
  );
  expect(inColumn).toMatchObject({ flex: "1 1 0", "min-height": "0", "min-width": "10px" });
  expect(inColumn["max-height"]).toBeUndefined();
  expect(inColumn["max-width"]).toBe("20px");
  const inRow = nodeCss(
    { weight: 1, ...bounds },
    { ...light, parentAxis: "row", weightsChildren: true },
  );
  expect(inRow).toMatchObject({ flex: "1 1 0", "min-width": "0", "min-height": "30px" });
  expect(inRow["max-width"]).toBeUndefined();
  expect(inRow["max-height"]).toBe("40px");
  // A line that shares no weight (a scroll, sheet or stack) keeps every bound, as native does.
  const inScroll = nodeCss({ weight: 1, ...bounds }, { ...light, parentAxis: "column" });
  expect(inScroll).toMatchObject({ "min-height": "30px", "max-height": "40px" });
  // Unweighted, every bound holds.
  expect(nodeCss(bounds, { ...light, parentAxis: "column" })).toMatchObject({
    "min-height": "30px",
    "max-height": "40px",
  });
});

test("a weight share is exact only when every unweighted sibling's height is known (#16698)", () => {
  const dp = { type: "box", style: { height: { dp: 10 } } };
  const weighted = { type: "row", style: { weight: 1, height: { dp: 10 } } };
  expect(exactWeightShares([dp, undefined, weighted])).toBe(true);
  expect(exactWeightShares([{ type: "box", style: { height: "fill" } }, weighted])).toBe(true);
  expect(exactWeightShares([{ type: "column" }, weighted])).toBe(false);
  expect(exactWeightShares([{ type: "text", style: { minHeight: 30 } }, weighted])).toBe(false);
  // A wrap sibling of unknown height leaves the share an upper bound: the row keeps its dp height,
  // so its aspect ratio errs small rather than overflowing a share it may not get.
  const children = [
    { type: "column", children: [{ type: "box", style: { height: { dp: 80 } } }] },
    { ...weighted, children: [{ type: "box", style: { aspectRatio: 2 } }, { type: "text" }] },
  ];
  const column = withColumnHeights({ type: "column", children }, "root", prepare, 100);
  const row = record(record(childrenOf(column)[1])?.style);
  expect(row?.[INCOMING_ALLOCATED_KEY]).toBeUndefined();
  expect(rowContentHeight(row)).toBe(10);
  const repeat = { type: "column", repeat: { items: [{}, {}] }, children };
  const instances = repeatInstanceChildren(repeat, "root", [prepare, prepare], 100);
  expect(
    instances.map((entries) => record(record(entries[1])?.style)?.[INCOMING_ALLOCATED_KEY]),
  ).toEqual([undefined, undefined]);
});

test("a weighted row bounded around a capped aspect ratio keeps its share over its maxWidth (#16698)", () => {
  const row = { weight: 1, maxWidth: 20, [ROW_BOUND_KEY]: true };
  const weighting = { ...light, parentAxis: "row", weightsChildren: true } as const;
  expect(nodeCss(row, weighting)["max-width"]).toBe("100%");
  // In a column the weight pins its height, so the authored maxWidth still bounds it.
  expect(nodeCss(row, { ...weighting, parentAxis: "column" })["max-width"]).toBe("min(100%, 20px)");
  expect(nodeCss({ maxWidth: 20, [ROW_BOUND_KEY]: true }, light)["max-width"]).toBe(
    "min(100%, 20px)",
  );
});
