import { expect, test } from "bun:test";
import { record, type Raw } from "../../../../src/features/prototype/prototypeTemplate";
import {
  columnChildHeights,
  withColumnHeights,
} from "../../../../src/features/prototype/web/webIncomingHeight";
import {
  CAPPED_SHRINK,
  rowContentHeight,
  rowMeasured,
} from "../../../../src/features/prototype/web/webRowAspect";
import {
  INCOMING_HEIGHT_KEY,
  nodeCss,
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
