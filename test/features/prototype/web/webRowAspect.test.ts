import { expect, test } from "bun:test";
import { record, type Raw } from "../../../../src/features/prototype/prototypeTemplate";
import {
  contentHeightBound,
  isUnsizedAspectRatio,
  rowCapCss,
  rowChildOverrides,
  type RowBounds,
} from "../../../../src/features/prototype/web/webRowAspect";

const shown = (entry: unknown): Raw | undefined => record(entry);
const unbounded: RowBounds = { screenWidth: 411 };
const measure = (
  entries: readonly unknown[],
  bounds: RowBounds = unbounded,
  prepared: (entry: unknown) => Raw | undefined = shown,
) => rowChildOverrides(entries, prepared, bounds);

test("only an aspect ratio with no authored width, height or weight is unsized", () => {
  expect(isUnsizedAspectRatio({ type: "box", style: { aspectRatio: 2 } })).toBe(true);
  expect(isUnsizedAspectRatio({ type: "box", style: { aspectRatio: 2, width: "wrap" } })).toBe(
    false,
  );
  expect(isUnsizedAspectRatio({ type: "box", style: { aspectRatio: 2, height: { dp: 4 } } })).toBe(
    false,
  );
  expect(isUnsizedAspectRatio({ type: "box", style: { aspectRatio: 2, weight: 1 } })).toBe(false);
  expect(isUnsizedAspectRatio({ type: "box", style: { aspectRatio: 0 } })).toBe(false);
  // A max bound applies before the ratio natively, so a capped node may not take all the width.
  expect(isUnsizedAspectRatio({ type: "box", style: { aspectRatio: 2, maxWidth: 100 } })).toBe(
    false,
  );
  expect(isUnsizedAspectRatio({ type: "box", style: { aspectRatio: 2, maxHeight: 50 } })).toBe(
    false,
  );
  expect(isUnsizedAspectRatio(undefined)).toBe(false);
});

test("the first unsized aspect ratio takes the remaining width and later siblings get none", () => {
  const entries = [
    { type: "text", text: "a" },
    { type: "box", style: { aspectRatio: 2, background: "primary" } },
    { type: "text", text: "b" },
    { type: "box", style: { aspectRatio: 1 } },
  ];
  const measured = measure(entries);
  expect(measured.has(0)).toBe(false);
  expect(measured.get(1)).toEqual({ style: { weight: 1 } });
  expect(measured.get(2)).toEqual({ style: { maxWidth: 0 } });
  // A later aspect ratio is measured against no width either, as Compose's Row does.
  expect(measured.get(3)).toEqual({ style: { maxWidth: 0 } });
});

test("weighted children get no width, wherever they sit, once the aspect ratio takes it", () => {
  const entries = [
    { type: "spacer", style: { weight: 1 } },
    { type: "text", text: "a" },
    { type: "box", style: { aspectRatio: 2 } },
  ];
  const measured = measure(entries);
  expect(measured.get(0)).toEqual({ style: { maxWidth: 0 } });
  expect(measured.has(1)).toBe(false);
});

test("hidden children neither take the width nor lose theirs", () => {
  const entries = [
    { type: "box", style: { aspectRatio: 2 }, hidden: true },
    { type: "text", text: "a" },
    { type: "box", style: { aspectRatio: 3 } },
  ];
  const measured = measure(entries, unbounded, (entry) =>
    record(entry)?.hidden === true ? undefined : record(entry),
  );
  expect([...measured.keys()]).toEqual([2]);
  expect(measured.get(2)).toEqual({ style: { weight: 1 } });
});

test("a capped aspect ratio leaves its later siblings their width", () => {
  const entries = [
    { type: "box", style: { aspectRatio: 2, maxWidth: 100 } },
    { type: "box", style: { width: { dp: 40 } } },
  ];
  expect(measure(entries).size).toBe(0);
});

test("a row without an unsized aspect ratio keeps its children as authored", () => {
  const entries = [{ type: "box", style: { aspectRatio: 2, width: { dp: 40 } } }];
  expect(measure(entries).size).toBe(0);
});

test("in a bounded row, an aspect ratio too tall for the bound sizes from the height", () => {
  // A 411x100 row: a ratio-1 child is 100x100 and the 40dp box after it keeps its width.
  const entries = [
    { type: "box", style: { aspectRatio: 1 } },
    { type: "box", style: { width: { dp: 40 } } },
    { type: "spacer", style: { weight: 1 } },
  ];
  const measured = measure(entries, { height: 100, screenWidth: 411 });
  expect(measured.get(0)).toEqual({
    style: { width: { dp: 100 } },
    css: { "flex-shrink": "1", "min-width": "0" },
  });
  expect(measured.has(1)).toBe(false);
  expect(measured.has(2)).toBe(false);
});

test("in a bounded row, an aspect ratio whose width-first height fits takes the width", () => {
  // Ratio 4 across at most 411dp is under 103dp tall, so the 200dp bound never applies.
  const entries = [
    { type: "box", style: { aspectRatio: 4 } },
    { type: "box", style: { width: { dp: 40 } } },
  ];
  const measured = measure(entries, { height: 200, screenWidth: 411 });
  expect(measured.get(0)).toEqual({ style: { weight: 1 } });
  expect(measured.get(1)).toEqual({ style: { maxWidth: 0 } });
});

test("a height-sized aspect ratio leaves a later width-first one to take the rest", () => {
  const entries = [
    { type: "box", style: { aspectRatio: 1 } },
    { type: "box", style: { aspectRatio: 9 } },
    { type: "text", text: "a" },
  ];
  const measured = measure(entries, { height: 50, screenWidth: 411 });
  expect(measured.get(0)?.style).toEqual({ width: { dp: 50 } });
  expect(measured.get(1)).toEqual({ style: { weight: 1 } });
  expect(measured.get(2)).toEqual({ style: { maxWidth: 0 } });
});

test("a content height bound is the tightest of height, maxHeight and inherited, less padding", () => {
  expect(contentHeightBound(undefined, undefined)).toBeUndefined();
  expect(contentHeightBound({ height: "wrap" }, undefined)).toBeUndefined();
  expect(contentHeightBound({ height: { dp: 100 } }, undefined)).toBe(100);
  expect(contentHeightBound({ height: { dp: 100 } }, 80)).toBe(80);
  expect(contentHeightBound({ maxHeight: 60 }, 80)).toBe(60);
  expect(contentHeightBound({ height: "fill" }, 80)).toBe(80);
  expect(contentHeightBound({ height: { dp: 100 }, padding: { top: 8, bottom: 12 } }, 300)).toBe(
    80,
  );
  expect(contentHeightBound({ height: { dp: 4 }, padding: { top: 8 } }, undefined)).toBe(0);
});

test("a row caps itself at its parent's width only around a height-sized child", () => {
  const shrink = new Map([["r.children[0]", { style: {}, css: { "flex-shrink": "1" } }]]);
  const grow = new Map([["r.children[0]", { style: { weight: 1 } }]]);
  expect(rowCapCss({ type: "row" }, shrink)).toEqual({ "max-width": "100%" });
  expect(rowCapCss({ type: "row", style: { maxWidth: 200 } }, shrink)).toEqual({});
  expect(rowCapCss({ type: "row" }, grow)).toEqual({});
});
