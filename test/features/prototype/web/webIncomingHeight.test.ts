import { expect, test } from "bun:test";
import { record, type Raw } from "../../../../src/features/prototype/prototypeTemplate";
import {
  columnChildHeights,
  contentHeight,
  exactWeightShares,
  withChildHeights,
} from "../../../../src/features/prototype/web/webIncomingHeight";
import { CAPPED_SHRINK, rowMeasured } from "../../../../src/features/prototype/web/webRowAspect";
import {
  INCOMING_HEIGHT_KEY,
  nodeCss,
  ROW_MEASURE_KEY,
  WEIGHTED_HEIGHT_KEY,
} from "../../../../src/features/prototype/web/webStyle";

const prepare = (entry: unknown) => record(entry);
const heightOf = (entry: unknown) => record(record(entry)?.style)?.[INCOMING_HEIGHT_KEY];
const childrenOf = (node: Raw) => node.children as unknown[];
const weightedOf = (entry: unknown) => record(record(entry)?.style)?.[WEIGHTED_HEIGHT_KEY];
const light = { mode: "light", palette: new Map() } as const;

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

test("a column's weighted child takes its whole share, whatever its dp height and bounds", () => {
  const share = { [INCOMING_HEIGHT_KEY]: 100, [WEIGHTED_HEIGHT_KEY]: true };
  expect(contentHeight({ weight: 1, height: { dp: 10 }, ...share })).toBe(100);
  expect(
    contentHeight({ weight: 1, height: { dp: 10 }, maxHeight: 5, minHeight: 200, ...share }),
  ).toBe(100);
  expect(contentHeight({ weight: 1, height: { dp: 10 }, padding: { top: 4 }, ...share })).toBe(96);
  // Unmarked (a row's weighted child, whose weight is horizontal), the dp height still bounds it.
  expect(contentHeight({ weight: 1, height: { dp: 10 }, [INCOMING_HEIGHT_KEY]: 100 })).toBe(10);
});

test("a column marks only its weighted children; a row, box or repeat marks none", () => {
  const children = [
    { type: "row", style: { weight: 1, height: { dp: 10 } } },
    { type: "box", style: { height: { dp: 10 } } },
  ];
  const column = { type: "column", style: { height: { dp: 100 } }, children };
  const marked = childrenOf(withChildHeights(column, "root", prepare));
  expect(marked.map(heightOf)).toEqual([90, 100]);
  expect(marked.map(weightedOf)).toEqual([true, undefined]);
  for (const node of [
    { ...column, type: "row" },
    { ...column, repeat: { items: [] } },
  ]) {
    expect(childrenOf(withChildHeights(node, "root", prepare)).map(weightedOf)).toEqual([
      undefined,
      undefined,
    ]);
  }
  // A weight a styleWhen adds counts, as rendering resolves it.
  const styled = (entry: unknown) => {
    const node = record(entry);
    return node?.type === "box" ? { ...node, style: { ...record(node.style), weight: 1 } } : node;
  };
  const resolved = childrenOf(withChildHeights(column, "root", styled));
  expect(resolved.map(weightedOf)).toEqual([true, true]);
  // The key is internal: it never reaches the CSS.
  expect(nodeCss({ [WEIGHTED_HEIGHT_KEY]: true }, light)).toEqual({ "box-sizing": "border-box" });
});

test("a weighted row with a 10 dp height in a 100 dp column caps its aspect ratio by its share", () => {
  const column = withChildHeights(
    {
      type: "column",
      style: { height: { dp: 100 } },
      children: [
        {
          type: "row",
          style: { weight: 1, height: { dp: 10 } },
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
    basis: 200,
  });
});

test("a weight drops the authored bounds on its main axis, as both devices pin it to its share", () => {
  const bounds = { minWidth: 10, maxWidth: 20, minHeight: 30, maxHeight: 40 };
  const inColumn = nodeCss(
    { weight: 1, height: { dp: 10 }, ...bounds },
    {
      ...light,
      parentAxis: "column",
    },
  );
  expect(inColumn).toMatchObject({ flex: "1 1 0", "min-height": "0", "min-width": "10px" });
  expect(inColumn["max-height"]).toBeUndefined();
  expect(inColumn["max-width"]).toBe("20px");
  const inRow = nodeCss({ weight: 1, ...bounds }, { ...light, parentAxis: "row" });
  expect(inRow).toMatchObject({ flex: "1 1 0", "min-width": "0", "min-height": "30px" });
  expect(inRow["max-width"]).toBeUndefined();
  expect(inRow["max-height"]).toBe("40px");
  // Unweighted, every bound holds.
  expect(nodeCss(bounds, { ...light, parentAxis: "column" })).toMatchObject({
    "min-height": "30px",
    "max-height": "40px",
  });
});

test("a weight share is exact only when every unweighted sibling has a dp height", () => {
  const dp = { type: "box", style: { height: { dp: 10 } } };
  const weighted = { type: "row", style: { weight: 1, height: { dp: 10 } } };
  expect(exactWeightShares([dp, undefined, weighted])).toBe(true);
  expect(exactWeightShares([{ type: "column" }, weighted])).toBe(false);
  expect(exactWeightShares([{ type: "text", style: { minHeight: 30 } }, weighted])).toBe(false);
  // A wrap sibling of unknown height leaves the share an upper bound: the row keeps its dp height,
  // so its aspect ratio errs small rather than overflowing a share it may not get.
  const column = withChildHeights(
    {
      type: "column",
      style: { height: { dp: 100 } },
      children: [
        { type: "column", children: [{ type: "box", style: { height: { dp: 80 } } }] },
        { ...weighted, children: [{ type: "box", style: { aspectRatio: 2 } }, { type: "text" }] },
      ],
    },
    "root",
    prepare,
  );
  const row = record(childrenOf(column)[1])!;
  expect(weightedOf(row)).toBeUndefined();
  expect(contentHeight(record(row.style))).toBe(10);
});
