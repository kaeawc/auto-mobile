import { describe, expect, test } from "bun:test";
import { stableStringify } from "../../src/utils/stableStringify";

describe("stableStringify", () => {
  test("key order does not change the output", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  test("different content still produces different output", () => {
    expect(stableStringify({ a: 1, b: 2 })).not.toBe(stableStringify({ a: 1, b: 3 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 1, b: 2 }));
  });

  test("nested objects are sorted at every level", () => {
    const left = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const right = { outer: { a: { b: 3, y: 2 }, z: 1 } };
    expect(stableStringify(left)).toBe(stableStringify(right));
  });

  test("array element order is preserved (it is meaningful)", () => {
    expect(stableStringify({ v: [1, 2] })).not.toBe(stableStringify({ v: [2, 1] }));
  });

  test("objects nested inside arrays are sorted", () => {
    expect(stableStringify({ v: [{ a: 1, b: 2 }] })).toBe(stableStringify({ v: [{ b: 2, a: 1 }] }));
  });

  test("primitives and null round-trip like JSON.stringify", () => {
    expect(stableStringify("x")).toBe('"x"');
    expect(stableStringify(3)).toBe("3");
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify({ a: undefined, b: 1 })).toBe(stableStringify({ b: 1 }));
  });
});
