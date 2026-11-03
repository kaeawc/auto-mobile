import { expect, test } from "bun:test";
import { record, type Raw } from "../../../../src/features/prototype/prototypeTemplate";
import {
  isUnsizedAspectRatio,
  rowContentHeight,
  rowFillAxes,
  rowHeightSizedChildren,
  rowMeasured,
  rowSequentialChildren,
  widthBoundContext,
  withChildHeights,
} from "../../../../src/features/prototype/web/webRowAspect";
import {
  INCOMING_HEIGHT_KEY,
  type WebStyleContext,
} from "../../../../src/features/prototype/web/webStyle";

const shown = (entry: unknown): Raw | undefined => record(entry);
const styleOf = (entry: unknown) => record(record(entry)?.style);

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
  const measured = rowSequentialChildren(entries, shown);
  expect(measured[0]).toBe(entries[0]);
  expect(styleOf(measured[1])).toEqual({ aspectRatio: 2, background: "primary", weight: 1 });
  expect(styleOf(measured[2])).toEqual({ maxWidth: 0 });
  // A later aspect ratio is measured against no width either, as Compose's Row does.
  expect(styleOf(measured[3])).toEqual({ aspectRatio: 1, maxWidth: 0 });
});

test("weighted children get no width, wherever they sit, once the aspect ratio takes it", () => {
  const entries = [
    { type: "spacer", style: { weight: 1 } },
    { type: "text", text: "a" },
    { type: "box", style: { aspectRatio: 2 } },
  ];
  const measured = rowSequentialChildren(entries, shown);
  expect(styleOf(measured[0])).toEqual({ weight: 1, maxWidth: 0 });
  expect(measured[1]).toBe(entries[1]);
});

test("hidden children neither take the width nor lose theirs", () => {
  const entries = [
    { type: "box", style: { aspectRatio: 2 }, hidden: true },
    { type: "text", text: "a" },
    { type: "box", style: { aspectRatio: 3 } },
  ];
  const measured = rowSequentialChildren(entries, (entry) =>
    record(entry)?.hidden === true ? undefined : record(entry),
  );
  expect(measured[0]).toBe(entries[0]);
  expect(measured[1]).toBe(entries[1]);
  expect(styleOf(measured[2])).toEqual({ aspectRatio: 3, weight: 1 });
});

test("a capped aspect ratio leaves its later siblings their width", () => {
  const entries = [
    { type: "box", style: { aspectRatio: 2, maxWidth: 100 } },
    { type: "box", style: { width: { dp: 40 } } },
  ];
  expect(rowSequentialChildren(entries, shown)).toBe(entries);
});

test("a row without an unsized aspect ratio keeps its children as authored", () => {
  const entries = [{ type: "box", style: { aspectRatio: 2, width: { dp: 40 } } }];
  expect(rowSequentialChildren(entries, shown)).toBe(entries);
});

test("a row's content height is its own or handed height less its vertical padding", () => {
  expect(rowContentHeight(undefined)).toBe(Infinity);
  expect(rowContentHeight({ height: "fill" })).toBe(Infinity);
  expect(rowContentHeight({ height: { dp: 100 }, padding: { top: 10, bottom: 5 } })).toBe(85);
  expect(rowContentHeight({ [INCOMING_HEIGHT_KEY]: 100, maxHeight: 60 })).toBe(60);
  expect(rowContentHeight({ [INCOMING_HEIGHT_KEY]: 50, height: { dp: 80 } })).toBe(50);
  expect(rowContentHeight({ [INCOMING_HEIGHT_KEY]: 50, minHeight: 70 })).toBe(70);
  expect(rowContentHeight({ height: { dp: 10 }, padding: { top: 20 } })).toBe(0);
});

test("under an unbounded width an unsized aspect ratio sizes from the height", () => {
  const entries = [
    { type: "box", style: { aspectRatio: 2, background: "primary" } },
    { type: "box", style: { width: { dp: 40 } } },
    { type: "box", style: { aspectRatio: 1, maxWidth: 10 } },
  ];
  const measured = rowHeightSizedChildren(entries, shown, 50);
  expect(styleOf(measured[0])).toEqual({
    aspectRatio: 2,
    background: "primary",
    width: { dp: 100 },
    height: { dp: 50 },
  });
  // Later siblings keep their width, and a capped ratio stays as authored.
  expect(measured[1]).toBe(entries[1]);
  expect(measured[2]).toBe(entries[2]);
});

test("under an unbounded width with no definite height the children stay as authored", () => {
  const entries = [
    { type: "box", style: { aspectRatio: 2 } },
    { type: "box", style: { width: { dp: 40 } } },
  ];
  expect(rowHeightSizedChildren(entries, shown, Infinity)).toBe(entries);
  expect(rowHeightSizedChildren([entries[1]], shown, 50)[0]).toBe(entries[1]);
});

test("a row under an unbounded width neither takes nor fills the width", () => {
  const row = {
    type: "row",
    style: { [INCOMING_HEIGHT_KEY]: 100, padding: { top: 10, bottom: 10 } },
    children: [
      { type: "box", style: { aspectRatio: 1 } },
      { type: "box", style: { width: { dp: 40 } } },
    ],
  };
  const prepare = (entry: unknown) => record(entry);
  expect(rowFillAxes(row, "root", prepare)).toEqual(["width"]);
  expect(rowFillAxes(row, "root", prepare, { unboundedWidth: true })).toEqual([]);
  const measured = rowMeasured(row, "root", prepare, { unboundedWidth: true });
  const children = measured.children as unknown[];
  expect(styleOf(children[0])).toEqual({
    aspectRatio: 1,
    width: { dp: 80 },
    height: { dp: 80 },
    [INCOMING_HEIGHT_KEY]: 80,
  });
  // A later sibling keeps its width, and is handed the row's height for its own children.
  expect(styleOf(children[1])).toEqual({ width: { dp: 40 }, [INCOMING_HEIGHT_KEY]: 80 });
  // Bounded, the same row keeps Compose's sequential measure.
  const bounded = rowMeasured(row, "root", prepare).children as unknown[];
  expect(styleOf(bounded[0])).toEqual({ aspectRatio: 1, weight: 1 });
});

test("a horizontal scroll hands its child its definite content height only", () => {
  const child = { type: "row", style: { spacing: 4 } };
  const scroll = (style: Raw) => ({ type: "scroll", style, child });
  const unbounded = { unboundedWidth: true };
  const handed = withChildHeights(scroll({ height: { dp: 100 }, padding: { top: 8 } }), unbounded);
  expect(styleOf(handed.child)).toEqual({ spacing: 4, [INCOMING_HEIGHT_KEY]: 92 });
  expect(withChildHeights(scroll({ height: "fill" }), unbounded).child).toBe(child);
  // A vertical scroll's content is width-bounded, so it hands no height.
  expect(withChildHeights(scroll({ height: { dp: 100 } }), {}).child).toBe(child);
  const empty = { type: "scroll", style: { height: { dp: 100 } } };
  expect(withChildHeights(empty, unbounded)).toBe(empty);
});

test("a node with a dp width or maxWidth bounds its content's width again", () => {
  const context: WebStyleContext = { mode: "light", palette: new Map(), unboundedWidth: true };
  expect(widthBoundContext(context, { width: { dp: 200 } }).unboundedWidth).toBe(false);
  expect(widthBoundContext(context, { maxWidth: 200 }).unboundedWidth).toBe(false);
  // fillMaxWidth against an unbounded width is no bound.
  expect(widthBoundContext(context, { width: "fill" })).toBe(context);
  const bounded: WebStyleContext = { ...context, unboundedWidth: undefined };
  expect(widthBoundContext(bounded, { width: { dp: 200 } })).toBe(bounded);
});

test("under an unbounded width a row or box hands its children its content height", () => {
  const children = [{ type: "row", children: [] }, "skipped"];
  const box = { type: "box", style: { [INCOMING_HEIGHT_KEY]: 100, padding: { top: 5 } }, children };
  const handed = withChildHeights(box, { unboundedWidth: true });
  expect(styleOf((handed.children as unknown[])[0])).toEqual({ [INCOMING_HEIGHT_KEY]: 95 });
  expect((handed.children as unknown[])[1]).toBe("skipped");
  expect(withChildHeights({ ...box, type: "row" }, { unboundedWidth: true })).not.toBe(box);
  // Bounded, a column, or no definite height: the children stay as authored.
  expect(withChildHeights(box, {})).toBe(box);
  expect(withChildHeights({ ...box, type: "column" }, { unboundedWidth: true }).children).toBe(
    children,
  );
  const unsized = { type: "box", children };
  expect(withChildHeights(unsized, { unboundedWidth: true })).toBe(unsized);
});
