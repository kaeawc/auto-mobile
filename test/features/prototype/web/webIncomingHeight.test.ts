import { expect, test } from "bun:test";
import { record, type Raw } from "../../../../src/features/prototype/prototypeTemplate";
import {
  columnChildHeights,
  contentHeight,
  withChildHeights,
} from "../../../../src/features/prototype/web/webIncomingHeight";
import { CAPPED_SHRINK, rowMeasured } from "../../../../src/features/prototype/web/webRowAspect";
import {
  INCOMING_ALLOCATED_KEY,
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
  const floored = { type: "text", style: { minHeight: 30 } };
  expect(columnChildHeights([floored, weighted(1)], 100, 0)).toEqual([100, 70]);
  // A sibling with no dp height counts as 0, so the bound is an upper one.
  expect(columnChildHeights([{ type: "text" }, weighted(1)], 40, 0)).toEqual([40, 40]);
  expect(columnChildHeights([dp(50), weighted(1)], 40, 0)).toEqual([40, 0]);
  // A maxHeight alone is a ceiling, not a height the sibling takes.
  const ceiling = { type: "box", style: { maxHeight: 100 } };
  expect(columnChildHeights([ceiling, weighted(1)], 100, 0)).toEqual([100, 100]);
  const floor = { type: "box", style: { maxHeight: 100, minHeight: 10 } };
  expect(columnChildHeights([floor, weighted(1)], 100, 0)).toEqual([100, 90]);
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

test("a card hands its children heights as a column does, with no spacing (#16690)", () => {
  const card = withChildHeights(
    {
      type: "card",
      style: { height: { dp: 100 }, padding: { top: 10, bottom: 10 }, spacing: 8 },
      children: [
        { type: "box", style: { height: { dp: 20 } } },
        { type: "row", style: { weight: 1 } },
      ],
    },
    "root",
    prepare,
  );
  // 80 dp of content: the box gets all of it, the weighted row what the box left; a card's
  // children are not spaced, so `spacing` takes nothing.
  expect(childrenOf(card).map(heightOf)).toEqual([80, 60]);
  // An unbounded card hands nothing down.
  const loose = withChildHeights({ type: "card", children: [{ type: "row" }] }, "root", prepare);
  expect(childrenOf(loose).map(heightOf)).toEqual([undefined]);
});

test("only a row, column, box or card hands its children a height (#16690)", () => {
  const node = { type: "toString", style: { height: { dp: 50 } }, children: [{ type: "row" }] };
  expect(withChildHeights(node, "root", prepare)).toBe(node);
});

test("a column's weight allocation sizes a child past its own dp height (#16701)", () => {
  const allocated = { [INCOMING_HEIGHT_KEY]: 80, [INCOMING_ALLOCATED_KEY]: true };
  expect(contentHeight({ ...allocated, weight: 1, height: { dp: 20 } })).toBe(80);
  // CSS still applies max-height and then min-height to a flex item, so both clamp the share.
  expect(contentHeight({ ...allocated, weight: 1, maxHeight: 50, padding: { top: 5 } })).toBe(45);
  expect(contentHeight({ ...allocated, weight: 1, minHeight: 100 })).toBe(100);
  expect(contentHeight({ ...allocated, weight: 1, minHeight: 100, maxHeight: 50 })).toBe(100);
  // Without the mark, the incoming height is a ceiling the child's own height can undercut.
  expect(contentHeight({ [INCOMING_HEIGHT_KEY]: 80, weight: 1, height: { dp: 20 } })).toBe(20);
  // A mark with no incoming height bounds nothing.
  expect(contentHeight({ [INCOMING_ALLOCATED_KEY]: true, height: { dp: 20 } })).toBe(20);
});

test("a weighted row with a dp height in a 100 dp column caps its aspect ratio by its share (#16701)", () => {
  const column = withChildHeights(
    {
      type: "column",
      style: { height: { dp: 100 } },
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
  );
  const [box, row] = childrenOf(column).map((entry) => record(record(entry)?.style));
  expect(box?.[INCOMING_ALLOCATED_KEY]).toBeUndefined();
  expect(row?.[INCOMING_ALLOCATED_KEY]).toBe(true);
  const ratio = childrenOf(
    rowMeasured(record(childrenOf(column)[1])!, "root.children[1]", prepare),
  );
  expect(record(record(ratio[0])?.style)?.[ROW_MEASURE_KEY]).toEqual({
    shrink: CAPPED_SHRINK,
    basis: 160,
  });
});

test("only a column's or card's weighted child is marked as allocated (#16701)", () => {
  const children = [{ type: "row", style: { weight: 1, height: { dp: 20 } } }];
  const allocatedOf = (node: Raw) =>
    childrenOf(withChildHeights(node, "root", prepare)).map(
      (entry) => record(record(entry)?.style)?.[INCOMING_ALLOCATED_KEY],
    );
  const style = { height: { dp: 100 } };
  expect(allocatedOf({ type: "card", style, children })).toEqual([true]);
  // A weight in a row is horizontal, and a repeat's template children are only bounded.
  expect(allocatedOf({ type: "row", style, children })).toEqual([undefined]);
  expect(allocatedOf({ type: "box", style, children })).toEqual([undefined]);
  expect(allocatedOf({ type: "column", style, children, repeat: { items: [] } })).toEqual([
    undefined,
  ]);
  // The key is internal: it never reaches the CSS.
  const css = nodeCss({ [INCOMING_ALLOCATED_KEY]: true }, { mode: "light", palette: new Map() });
  expect(css).toEqual({ "box-sizing": "border-box" });
});

test("a clamped weighted child hands what it leaves to its weighted siblings, as CSS flex does (#16763)", () => {
  const weighted = (weight: number, bounds: Raw = {}) => ({
    type: "row",
    style: { weight, ...bounds },
  });
  // The issue's case: CSS freezes the 20 dp row at its maxHeight and grows its sibling to 80.
  expect(columnChildHeights([weighted(1, { maxHeight: 20 }), weighted(1)], 100, 0)).toEqual([
    20, 80,
  ]);
  // A minHeight above the share takes height from the siblings.
  expect(columnChildHeights([weighted(1, { minHeight: 70 }), weighted(1)], 100, 0)).toEqual([
    70, 30,
  ]);
  // Freezing one share can push another past its bound, so the loop runs until none moves.
  expect(
    columnChildHeights(
      [weighted(1, { maxHeight: 10 }), weighted(1, { maxHeight: 40 }), weighted(2)],
      100,
      0,
    ),
  ).toEqual([10, 30, 60]);
  expect(
    columnChildHeights(
      [weighted(1, { maxHeight: 10 }), weighted(1, { maxHeight: 25 }), weighted(2)],
      100,
      0,
    ),
  ).toEqual([10, 25, 65]);
  // Min and max violations that cancel out freeze every share where it is clamped.
  expect(
    columnChildHeights([weighted(1, { maxHeight: 40 }), weighted(1, { minHeight: 60 })], 100, 0),
  ).toEqual([40, 60]);
  // Unweighted siblings, spacing and hidden children are taken off before the weights share.
  expect(
    columnChildHeights(
      [
        { type: "box", style: { height: { dp: 20 } } },
        undefined,
        weighted(1, { maxHeight: 10 }),
        weighted(3),
      ],
      100,
      5,
    ),
  ).toEqual([100, undefined, 10, 60]);
  // Every share clamped by its own max leaves the rest unallocated.
  expect(
    columnChildHeights([weighted(1, { maxHeight: 10 }), weighted(1, { maxHeight: 20 })], 100, 0),
  ).toEqual([10, 20]);
  // Mins past the free space each keep their min, as CSS's min-height wins over the container.
  expect(
    columnChildHeights([weighted(1, { minHeight: 80 }), weighted(1, { minHeight: 40 })], 100, 0),
  ).toEqual([80, 40]);
});

test("a weighted row beside a maxHeight-clamped sibling caps its aspect ratio by the redistributed share (#16763)", () => {
  const column = withChildHeights(
    {
      type: "column",
      style: { height: { dp: 100 } },
      children: [
        { type: "box", style: { weight: 1, maxHeight: 20 } },
        {
          type: "row",
          style: { weight: 1 },
          children: [{ type: "box", style: { aspectRatio: 2 } }, { type: "text" }],
        },
      ],
    },
    "root",
    prepare,
  );
  expect(childrenOf(column).map(heightOf)).toEqual([20, 80]);
  const ratio = childrenOf(
    rowMeasured(record(childrenOf(column)[1])!, "root.children[1]", prepare),
  );
  expect(record(record(ratio[0])?.style)?.[ROW_MEASURE_KEY]).toEqual({
    shrink: CAPPED_SHRINK,
    basis: 160,
  });
});
