import { expect, test } from "bun:test";
import { record, type Raw } from "../../../../src/features/prototype/prototypeTemplate";
import {
  aspectRatioCap,
  CAPPED_SHRINK,
  isUnsizedAspectRatio,
  LATER_SHRINK,
  rowContentHeight,
  rowMeasured,
  rowSequentialChildren,
} from "../../../../src/features/prototype/web/webRowAspect";
import {
  laterMinStrut,
  nodeCss,
  ROW_BOUND_KEY,
  ROW_MEASURE_KEY,
  containerChildStyle,
  scrollChildStyle,
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
  expect(styleOf(measured[1])).toEqual({
    aspectRatio: 2,
    background: "primary",
    [ROW_MEASURE_KEY]: { take: true },
  });
  expect(styleOf(measured[2])).toEqual({ [ROW_MEASURE_KEY]: { zero: true } });
  // A later aspect ratio is measured against no width either, as Compose's Row does.
  expect(styleOf(measured[3])).toEqual({ aspectRatio: 1, [ROW_MEASURE_KEY]: { zero: true } });
});

test("weighted children get no width, wherever they sit, once the aspect ratio takes it", () => {
  const entries = [
    { type: "spacer", style: { weight: 1 } },
    { type: "text", text: "a" },
    { type: "box", style: { aspectRatio: 2 } },
  ];
  const measured = rowSequentialChildren(entries, shown);
  expect(styleOf(measured[0])).toEqual({ weight: 1, [ROW_MEASURE_KEY]: { zero: true } });
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
  expect(styleOf(measured[2])).toEqual({ aspectRatio: 3, [ROW_MEASURE_KEY]: { take: true } });
});

test("a capped aspect ratio's cap is the tighter of maxWidth and maxHeight times the ratio", () => {
  expect(aspectRatioCap({ type: "box", style: { aspectRatio: 2, maxWidth: 100 } })).toBe(100);
  expect(aspectRatioCap({ type: "box", style: { aspectRatio: 2, maxHeight: 30 } })).toBe(60);
  expect(
    aspectRatioCap({ type: "box", style: { aspectRatio: 2, maxWidth: 100, maxHeight: 80 } }),
  ).toBe(100);
  expect(
    aspectRatioCap({ type: "box", style: { aspectRatio: 2, maxWidth: 100, maxHeight: 20 } }),
  ).toBe(40);
  // Unsized, sized, or weighted nodes have no cap.
  expect(aspectRatioCap({ type: "box", style: { aspectRatio: 2 } })).toBeUndefined();
  expect(
    aspectRatioCap({ type: "box", style: { aspectRatio: 2, maxWidth: 100, width: { dp: 9 } } }),
  ).toBeUndefined();
  expect(
    aspectRatioCap({ type: "box", style: { aspectRatio: 2, maxWidth: 9, weight: 1 } }),
  ).toBeUndefined();
  expect(aspectRatioCap({ type: "box", style: { maxWidth: 100 } })).toBeUndefined();
  expect(aspectRatioCap(undefined)).toBeUndefined();
});

test("a capped aspect ratio grows to its cap and its later siblings give up width first", () => {
  const entries = [
    { type: "text", text: "a" },
    { type: "box", style: { aspectRatio: 2, maxHeight: 30 } },
    { type: "box", style: { width: { dp: 40 } } },
    { type: "spacer", style: { weight: 1 } },
  ];
  const measured = rowSequentialChildren(entries, shown);
  expect(measured[0]).toBe(entries[0]);
  expect(styleOf(measured[1])).toEqual({
    aspectRatio: 2,
    maxHeight: 30,
    [ROW_MEASURE_KEY]: { shrink: CAPPED_SHRINK, basis: 60 },
  });
  expect(styleOf(measured[2])).toEqual({
    width: { dp: 40 },
    [ROW_MEASURE_KEY]: { shrink: LATER_SHRINK, later: true },
  });
  // A weighted sibling grows into whatever the cap and the later siblings leave.
  expect(measured[3]).toBe(entries[3]);
});

test("a later capped aspect ratio keeps its cap as its basis in the later tier", () => {
  const entries = [
    { type: "box", style: { aspectRatio: 1, maxWidth: 50 } },
    { type: "box", style: { aspectRatio: 1, maxWidth: 20 } },
  ];
  const measured = rowSequentialChildren(entries, shown);
  expect(styleOf(measured[1])?.[ROW_MEASURE_KEY]).toEqual({
    shrink: LATER_SHRINK,
    later: true,
    basis: 20,
  });
});

test("an unsized aspect ratio after a capped one takes what the cap leaves", () => {
  const entries = [
    { type: "box", style: { aspectRatio: 2, maxWidth: 100 } },
    { type: "text", text: "a" },
    { type: "box", style: { aspectRatio: 1 } },
    { type: "text", text: "b" },
  ];
  const measured = rowSequentialChildren(entries, shown);
  expect(styleOf(measured[0])?.[ROW_MEASURE_KEY]).toEqual({ shrink: CAPPED_SHRINK, basis: 100 });
  expect(styleOf(measured[1])).toEqual({
    [ROW_MEASURE_KEY]: { shrink: LATER_SHRINK, later: true },
  });
  expect(styleOf(measured[2])).toEqual({ aspectRatio: 1, [ROW_MEASURE_KEY]: { take: true } });
  expect(styleOf(measured[3])).toEqual({ [ROW_MEASURE_KEY]: { zero: true } });
});

test("a capped aspect ratio after an unsized one gets no width", () => {
  const entries = [
    { type: "box", style: { aspectRatio: 1 } },
    { type: "box", style: { aspectRatio: 2, maxWidth: 100 } },
  ];
  const measured = rowSequentialChildren(entries, shown);
  expect(styleOf(measured[1])).toEqual({
    aspectRatio: 2,
    maxWidth: 100,
    [ROW_MEASURE_KEY]: { zero: true },
  });
});

test("a row measure becomes a flex basis and shrink in a row only", () => {
  const context = { mode: "light" as const, palette: new Map(), parentAxis: "row" as const };
  const capped = { aspectRatio: 2, maxWidth: 100, [ROW_MEASURE_KEY]: { shrink: 7, basis: 60 } };
  expect(nodeCss(capped, context)).toMatchObject({
    "flex-grow": "0",
    "flex-basis": "60px",
    "flex-shrink": "7",
    width: "60px",
    "min-width": "0",
    "max-width": "100px",
    "aspect-ratio": "2",
  });
  // A fixed width keeps its size but now gives it up in the later tier.
  const later = { width: { dp: 40 }, [ROW_MEASURE_KEY]: { shrink: 9 } };
  expect(nodeCss(later, context)).toMatchObject({ width: "40px", "flex-shrink": "9" });
  // An authored minWidth still holds, as Compose's sizeIn does.
  expect(nodeCss({ minWidth: 10, [ROW_MEASURE_KEY]: { shrink: 9 } }, context)["min-width"]).toBe(
    "10px",
  );
  expect(nodeCss(capped, { ...context, parentAxis: "column" })).not.toHaveProperty("flex-basis");
});

test("a later sibling's minWidth folds into its width instead of reserving width ahead of the cap", () => {
  const context = { mode: "light" as const, palette: new Map(), parentAxis: "row" as const };
  const later = (style: Raw, basis?: number) => ({
    ...style,
    [ROW_MEASURE_KEY]: { shrink: LATER_SHRINK, later: true, ...(basis ? { basis } : {}) },
  });
  // A fixed width at its minimum: the min no longer holds against shrinking (Android gives 0).
  expect(nodeCss(later({ width: { dp: 40 }, minWidth: 40 }), context)).toMatchObject({
    width: "40px",
    "min-width": "0",
    "flex-shrink": String(LATER_SHRINK),
  });
  // While width remains it still renders at least its minWidth.
  expect(nodeCss(later({ width: { dp: 20 }, minWidth: 40 }), context)).toMatchObject({
    width: "40px",
    "min-width": "0",
  });
  // A content width has no px value to fold into: rendering wraps it around a strut instead.
  const content = nodeCss(later({ minWidth: 30 }), context);
  expect(content["min-width"]).toBe("0");
  expect(content).not.toHaveProperty("width");
  expect(laterMinStrut(later({ minWidth: 30 }), context)).toBe(30);
  expect(laterMinStrut(later({ width: "fill", minWidth: 30 }), context)).toBe(30);
  // A later capped ratio folds the minimum into its basis.
  expect(nodeCss(later({ aspectRatio: 1, maxWidth: 20, minWidth: 25 }, 20), context)).toMatchObject(
    { width: "25px", "flex-basis": "25px", "min-width": "0" },
  );
  // Without a minWidth the later tier is unchanged.
  expect(nodeCss(later({ width: { dp: 40 } }), context)).toMatchObject({
    width: "40px",
    "min-width": "0",
  });
});

test("only a later content- or fill-width sibling with a minWidth in a row needs a strut", () => {
  const context = { mode: "light" as const, palette: new Map(), parentAxis: "row" as const };
  const measure = { [ROW_MEASURE_KEY]: { shrink: LATER_SHRINK, later: true } };
  expect(laterMinStrut({ minWidth: 30, ...measure }, context)).toBe(30);
  // A px width or basis folds the minimum into its own width.
  expect(laterMinStrut({ width: { dp: 10 }, minWidth: 30, ...measure }, context)).toBeUndefined();
  const based = { [ROW_MEASURE_KEY]: { shrink: LATER_SHRINK, later: true, basis: 20 } };
  expect(laterMinStrut({ minWidth: 30, ...based }, context)).toBeUndefined();
  // Not later, no minWidth, or not in a row: nothing to wrap.
  expect(
    laterMinStrut({ minWidth: 30, [ROW_MEASURE_KEY]: { shrink: CAPPED_SHRINK } }, context),
  ).toBeUndefined();
  expect(laterMinStrut(measure, context)).toBeUndefined();
  expect(laterMinStrut({ minWidth: 30, ...measure }, { ...context, parentAxis: "column" })).toBe(
    undefined,
  );
  expect(laterMinStrut(undefined, context)).toBeUndefined();
});

test("a later sibling in a capped row is marked so its minWidth folds", () => {
  const entries = [
    { type: "box", style: { aspectRatio: 1, maxWidth: 100 } },
    { type: "box", style: { width: { dp: 40 }, minWidth: 40 } },
  ];
  const measured = rowSequentialChildren(entries, shown);
  expect(styleOf(measured[0])?.[ROW_MEASURE_KEY]).toEqual({ shrink: CAPPED_SHRINK, basis: 100 });
  expect(styleOf(measured[1])?.[ROW_MEASURE_KEY]).toEqual({ shrink: LATER_SHRINK, later: true });
});

test("a row without an unsized aspect ratio keeps its children as authored", () => {
  const entries = [{ type: "box", style: { aspectRatio: 2, width: { dp: 40 } } }];
  expect(rowSequentialChildren(entries, shown)).toBe(entries);
});

test("a row around a capped aspect ratio is bounded to its parent and its own maxWidth", () => {
  const prepare = (entry: unknown) => record(entry);
  const capped = { type: "box", style: { aspectRatio: 2, maxWidth: 100 } };
  const row = { type: "row", style: { padding: 4 }, children: [capped] };
  const measured = rowMeasured(row, "root", prepare);
  expect(measured.style).toEqual({ padding: 4, [ROW_BOUND_KEY]: true });
  // An unsized aspect ratio fills the row instead, so the row needs no bound.
  const free = rowMeasured(
    { type: "row", children: [{ type: "box", style: { aspectRatio: 2 } }] },
    "root",
    prepare,
  );
  expect(free.style).toBeUndefined();
  const plain = { type: "row", children: [{ type: "text", text: "a" }] };
  expect(rowMeasured(plain, "root", prepare)).toBe(plain);

  const context = { mode: "light" as const, palette: new Map(), parentAxis: "column" as const };
  expect(nodeCss(measured.style, context)["max-width"]).toBe("100%");
  expect(nodeCss({ maxWidth: 50, [ROW_BOUND_KEY]: true }, context)["max-width"]).toBe(
    "min(100%, 50px)",
  );
});

test("a conditional maxWidth or weight cannot undo the row measure (styleWhen merges again)", () => {
  const context = { mode: "light" as const, palette: new Map(), parentAxis: "row" as const };
  // Rendering merges an active styleWhen over the measured style; the hint key survives it.
  const zeroed = { width: { dp: 40 }, [ROW_MEASURE_KEY]: { zero: true }, maxWidth: 100 };
  expect(nodeCss(zeroed, context)["max-width"]).toBe("0px");
  const taker = { aspectRatio: 2, [ROW_MEASURE_KEY]: { take: true }, weight: 3 };
  expect(nodeCss(taker, context)).toMatchObject({ flex: "1 1 0", "min-width": "0" });
});

test("a row's definite content height is its dp height or maxHeight less vertical padding", () => {
  expect(rowContentHeight({ height: { dp: 20 } })).toBe(20);
  expect(
    rowContentHeight({ height: { dp: 40 }, maxHeight: 30, padding: { top: 4, bottom: 6 } }),
  ).toBe(20);
  expect(rowContentHeight({ height: { dp: 4 }, padding: { top: 4, bottom: 6 } })).toBe(0);
  expect(rowContentHeight({ height: "fill" })).toBe(Infinity);
  // sizeIn applies before the height, so a larger minHeight wins over the authored height.
  expect(rowContentHeight({ height: { dp: 20 }, minHeight: 100 })).toBe(100);
  expect(rowContentHeight({ minHeight: 100 })).toBe(Infinity);
  expect(rowContentHeight(undefined)).toBe(Infinity);
});

test("a row's definite height caps its aspect ratios, as the incoming max height does natively", () => {
  const prepare = (entry: unknown) => record(entry);
  const row = {
    type: "row",
    style: { width: "fill", height: { dp: 20 } },
    children: [
      { type: "box", style: { aspectRatio: 1, maxWidth: 100 } },
      { type: "box", style: { aspectRatio: 2 } },
    ],
  };
  const children = rowMeasured(row, "root", prepare).children as unknown[];
  expect(styleOf(children[0])?.[ROW_MEASURE_KEY]).toEqual({ shrink: CAPPED_SHRINK, basis: 20 });
  // An otherwise unsized ratio is capped by the row's height too, so it no longer takes the rest.
  expect(styleOf(children[1])?.[ROW_MEASURE_KEY]).toEqual({
    shrink: LATER_SHRINK,
    later: true,
    basis: 40,
  });
  expect(isUnsizedAspectRatio({ type: "box", style: { aspectRatio: 2 } }, 20)).toBe(false);
});

test("a row in a horizontal scroll is not bounded to the scroll's width", () => {
  const base = { mode: "light" as const, palette: new Map() };
  const across = { type: "scroll", axis: "horizontal" };
  const down = { type: "scroll", axis: "vertical" };
  const inScroll = scrollChildStyle({ style: base }, across);
  expect(inScroll).toMatchObject({ parentAxis: "row", unboundedWidth: true });
  // A vertical scroll inside it keeps the unbounded width; one on its own does not add it.
  expect(scrollChildStyle({ style: inScroll }, down)).toMatchObject({ unboundedWidth: true });
  expect(scrollChildStyle({ style: base }, down)).toMatchObject({
    parentAxis: "column",
    unboundedWidth: false,
  });
  expect(nodeCss({ [ROW_BOUND_KEY]: true }, inScroll)).not.toHaveProperty("max-width");
  expect(nodeCss({ maxWidth: 50, [ROW_BOUND_KEY]: true }, inScroll)["max-width"]).toBe("50px");
});

test("a nested bounded row that its parent row zeroes keeps no width", () => {
  const context = { mode: "light" as const, palette: new Map(), parentAxis: "row" as const };
  const nested = { [ROW_BOUND_KEY]: true, [ROW_MEASURE_KEY]: { zero: true } };
  expect(nodeCss(nested, context)["max-width"]).toBe("0px");
});

test("a container that authors a dp width or maxWidth bounds its children's width again", () => {
  const unbounded = { style: { mode: "light" as const, palette: new Map(), unboundedWidth: true } };
  const childOf = (style: Raw) =>
    containerChildStyle(unbounded, { type: "column", style }, "column");
  // Modifier.width or widthIn restores a finite max width, as on Android.
  expect(childOf({ width: { dp: 100 } })).toMatchObject({
    parentAxis: "column",
    unboundedWidth: false,
  });
  expect(childOf({ maxWidth: 100 }).unboundedWidth).toBe(false);
  expect(nodeCss({ [ROW_BOUND_KEY]: true }, childOf({ width: { dp: 100 } }))["max-width"]).toBe(
    "100%",
  );
  // A fill or wrap width under an infinite max stays unbounded, as do min and height bounds.
  for (const style of [
    {},
    { width: "fill" },
    { width: "wrap" },
    { minWidth: 40 },
    { maxHeight: 9 },
  ]) {
    expect(childOf(style).unboundedWidth).toBe(true);
  }
  // A bounded container's box, scroll or row children carry the reset down.
  const bounded = childOf({ maxWidth: 100 });
  expect(containerChildStyle({ style: bounded }, { type: "box" }, undefined).unboundedWidth).toBe(
    false,
  );
  // A horizontal scroll inside the bounded container unbounds its own content again.
  const across = { type: "scroll", axis: "horizontal", style: { width: { dp: 80 } } };
  expect(scrollChildStyle({ style: bounded }, across).unboundedWidth).toBe(true);
  expect(
    scrollChildStyle(unbounded, { type: "scroll", style: { width: { dp: 80 } } }),
  ).toMatchObject({
    parentAxis: "column",
    unboundedWidth: false,
  });
});
