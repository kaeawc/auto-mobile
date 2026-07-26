import { describe, expect, test } from "bun:test";
import { nextToPick } from "../../src/utils/Random";

// A14 (REFUTED rework): rather than shipping standalone probabilistic pick rows,
// test the exported index math directly with a deterministic `next()`. This pins
// the boundary indices (first, last, single-element, empty) with no flakiness.
describe("nextToPick index boundaries", () => {
  test("maps next()=0 to the first element", () => {
    expect(nextToPick(() => 0, ["a", "b", "c"])).toBe("a");
  });

  test("maps a next() just under 1 to the last element without overrunning", () => {
    expect(nextToPick(() => 0.999, ["a", "b", "c"])).toBe("c");
  });

  test("maps the midpoint of a two-element array to the second element", () => {
    expect(nextToPick(() => 0.5, ["a", "b"])).toBe("b");
  });

  test("returns the sole element of a single-item array regardless of next()", () => {
    expect(nextToPick(() => 0.999, ["only"])).toBe("only");
    expect(nextToPick(() => 0, ["only"])).toBe("only");
  });

  test("throws for an empty array", () => {
    expect(() => nextToPick(() => 0.5, [])).toThrow(/empty/);
  });
});
