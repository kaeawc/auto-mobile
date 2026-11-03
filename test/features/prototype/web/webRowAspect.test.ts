import { expect, test } from "bun:test";
import { record, type Raw } from "../../../../src/features/prototype/prototypeTemplate";
import {
  isUnsizedAspectRatio,
  rowSequentialChildren,
} from "../../../../src/features/prototype/web/webRowAspect";

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

test("a row without an unsized aspect ratio keeps its children as authored", () => {
  const entries = [{ type: "box", style: { aspectRatio: 2, width: { dp: 40 } } }];
  expect(rowSequentialChildren(entries, shown)).toBe(entries);
});
