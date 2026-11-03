import { expect, test } from "bun:test";
import { record, type Raw } from "../../../../src/features/prototype/prototypeTemplate";
import {
  columnChildHeights,
  contentHeight,
  repeatInstanceChildren,
  withChildHeights,
} from "../../../../src/features/prototype/web/webIncomingHeight";
import { CAPPED_SHRINK, rowMeasured } from "../../../../src/features/prototype/web/webRowAspect";
import {
  INCOMING_HEIGHT_KEY,
  nodeCss,
  ROW_MEASURE_KEY,
} from "../../../../src/features/prototype/web/webStyle";

const prepare = (entry: unknown) => record(entry);
const heightOf = (entry: unknown) => record(record(entry)?.style)?.[INCOMING_HEIGHT_KEY];
const childrenOf = (node: Raw) => node.children as unknown[];

test("a node's content height is the least of its incoming, dp and max height, less padding", () => {
  expect(contentHeight({ height: { dp: 20 } })).toBe(20);
  expect(contentHeight({ height: { dp: 40 }, maxHeight: 30, padding: { top: 4, bottom: 6 } })).toBe(
    20,
  );
  expect(contentHeight({ height: { dp: 4 }, padding: { top: 4, bottom: 6 } })).toBe(0);
  expect(contentHeight({ height: "fill" })).toBe(Infinity);
  expect(contentHeight(undefined)).toBe(Infinity);
  // The dp height is held to maxHeight, then raised to minHeight, as CSS and sizeIn resolve it.
  expect(contentHeight({ height: { dp: 20 }, minHeight: 100 })).toBe(100);
  expect(contentHeight({ height: { dp: 20 }, minHeight: 100, maxHeight: 50 })).toBe(100);
  expect(contentHeight({ minHeight: 30, [INCOMING_HEIGHT_KEY]: 40 })).toBe(40);
  // A fill, weighted or wrap node is bounded by what its parent hands it.
  expect(contentHeight({ height: "fill", [INCOMING_HEIGHT_KEY]: 40 })).toBe(40);
  expect(contentHeight({ weight: 1, [INCOMING_HEIGHT_KEY]: 30, padding: { top: 5 } })).toBe(25);
  expect(contentHeight({ height: { dp: 80 }, [INCOMING_HEIGHT_KEY]: 40 })).toBe(40);
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
    style: { height: { dp: 40 } },
    repeat: { items: [{}, {}] },
    children: [{ type: "row", style: { weight: 1 } }],
  };
  // Two weighted instances in a 40 dp column get 20 dp each, as on Android.
  expect(
    repeatInstanceChildren(weighted, "root", prepares).map((list) => list.map(heightOf)),
  ).toEqual([[20], [20]]);
  // Unweighted instances are measured in order, across instances, with the spacing between; the
  // wrap row counts as 0, so its bound is an upper one.
  const sequential = {
    ...weighted,
    style: { height: { dp: 40 }, spacing: 2 },
    children: [{ type: "box", style: { height: { dp: 10 } } }, { type: "row" }],
  };
  expect(
    repeatInstanceChildren(sequential, "root", prepares).map((list) => list.map(heightOf)),
  ).toEqual([
    [40, 28],
    [26, 14],
  ]);
  // A child hidden in one instance takes nothing there, not even spacing.
  const hiddenFirst = (entry: unknown, path: string) =>
    path.endsWith("[0]") ? undefined : prepare(entry);
  expect(
    repeatInstanceChildren(sequential, "root", [hiddenFirst, prepare]).map((list) =>
      list.map(heightOf),
    ),
  ).toEqual([
    [undefined, 40],
    [38, 26],
  ]);
});

test("a repeat that is not a bounded column keeps its template for every instance", () => {
  const children = [{ type: "row", style: { weight: 1 } }];
  const wrap = { type: "column", repeat: { items: [{}] }, children };
  expect(repeatInstanceChildren(wrap, "root", [prepare])).toEqual([children]);
  const row = { type: "row", style: { height: { dp: 40 } }, repeat: { items: [{}] }, children };
  expect(repeatInstanceChildren(row, "root", [prepare, prepare])).toEqual([children, children]);
  expect(repeatInstanceChildren({ ...wrap, style: { height: { dp: 40 } } }, "root", [])).toEqual(
    [],
  );
});

test("a row or box with a known content height hands it to every child", () => {
  for (const type of ["row", "box"]) {
    const node = withChildHeights(
      {
        type,
        style: { height: { dp: 40 }, padding: { top: 4, bottom: 4 } },
        children: [{ type: "text" }, { type: "box", style: { height: { dp: 10 } } }],
      },
      "root",
      prepare,
    );
    expect(childrenOf(node).map(heightOf)).toEqual([32, 32]);
  }
});

test("a column passes its known height down sequentially, and a repeat bounds every child", () => {
  const column = {
    type: "column",
    style: { height: { dp: 40 } },
    children: [{ type: "box", style: { height: { dp: 10 } } }, { type: "row" }],
  };
  expect(childrenOf(withChildHeights(column, "root", prepare)).map(heightOf)).toEqual([40, 30]);
  const repeated = withChildHeights({ ...column, repeat: { items: [] } }, "root", prepare);
  expect(childrenOf(repeated).map(heightOf)).toEqual([40, 40]);
});

test("a node with no known height, or one that lays out no line, leaves its children as authored", () => {
  const children = [{ type: "row" }];
  const wrap = { type: "column", children };
  expect(withChildHeights(wrap, "root", prepare)).toBe(wrap);
  const scroll = { type: "scroll", style: { height: { dp: 40 } }, children };
  expect(withChildHeights(scroll, "root", prepare)).toBe(scroll);
  // The key is internal: it never reaches the CSS.
  const css = nodeCss({ [INCOMING_HEIGHT_KEY]: 40 }, { mode: "light", palette: new Map() });
  expect(css).toEqual({ "box-sizing": "border-box" });
});

test("a fill-height row in a 40 dp column caps its aspect ratio at 40 dp × ratio", () => {
  const column = withChildHeights(
    {
      type: "column",
      style: { height: { dp: 40 } },
      children: [
        {
          type: "row",
          style: { height: "fill" },
          children: [{ type: "box", style: { aspectRatio: 2 } }, { type: "text" }],
        },
      ],
    },
    "root",
    prepare,
  );
  const row = record(childrenOf(column)[0])!;
  const ratio = childrenOf(rowMeasured(row, "root.children[0]", prepare))[0];
  expect(record(record(ratio)?.style)?.[ROW_MEASURE_KEY]).toEqual({
    shrink: CAPPED_SHRINK,
    basis: 80,
  });
});
