import { expect, test } from "bun:test";
import { cssLength } from "../../../../src/features/prototype/web/webCssLength";

test("reads px, zero and percentages of a known base", () => {
  expect(cssLength("12px", {})).toBe(12);
  expect(cssLength("-4.5px", {})).toBe(-4.5);
  expect(cssLength("0", {})).toBe(0);
  expect(cssLength("50%", {}, 300)).toBe(150);
});

test("anything it cannot resolve is unknown", () => {
  expect(cssLength(undefined, {})).toBeUndefined();
  expect(cssLength("auto", {})).toBeUndefined();
  expect(cssLength("12", {})).toBeUndefined();
  expect(cssLength("2em", {})).toBeUndefined();
  expect(cssLength("50%", {})).toBeUndefined();
  expect(cssLength("var(--missing)", {})).toBeUndefined();
  expect(cssLength("calc(10px - (2px + 1px))", {})).toBeUndefined();
});

test("resolves variables, nested variables and calc sums", () => {
  const vars = { "--safe-top": "24px", "--safe-start": "var(--safe-left)", "--safe-left": "8px" };
  expect(cssLength("var(--safe-top)", vars)).toBe(24);
  expect(cssLength("calc(16px + var(--safe-top))", vars)).toBe(40);
  expect(cssLength("calc(0px + var(--safe-start))", vars)).toBe(8);
  expect(cssLength("calc(100% - 10px)", vars, 200)).toBe(190);
});
