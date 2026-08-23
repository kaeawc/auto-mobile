import { expect, describe, test } from "bun:test";
import { topKByDescending } from "../../../src/utils/screenshot/ScreenshotMatcher";

// Reference implementation: stable descending sort + slice, which the helper
// must match exactly (order matters — callers consume newest-first).
function fullSortTopK<T>(items: T[], k: number, value: (item: T) => number): T[] {
  return [...items]
    .map((item, i) => ({ item, i, v: value(item) }))
    .sort((a, b) => b.v - a.v || a.i - b.i)
    .slice(0, Math.max(0, k))
    .map((entry) => entry.item);
}

describe("topKByDescending", () => {
  test("returns the k largest values in descending order", () => {
    const items = [{ v: 3 }, { v: 1 }, { v: 5 }, { v: 2 }, { v: 4 }];
    const result = topKByDescending(items, 3, (x) => x.v);
    expect(result.map((x) => x.v)).toEqual([5, 4, 3]);
  });

  test("returns everything sorted when k >= n", () => {
    const items = [{ v: 3 }, { v: 1 }, { v: 2 }];
    expect(topKByDescending(items, 10, (x) => x.v).map((x) => x.v)).toEqual([3, 2, 1]);
  });

  test("returns an empty array for k <= 0 or empty input", () => {
    expect(topKByDescending([{ v: 1 }], 0, (x) => x.v)).toEqual([]);
    expect(topKByDescending([{ v: 1 }], -1, (x) => x.v)).toEqual([]);
    expect(topKByDescending([] as { v: number }[], 5, (x) => x.v)).toEqual([]);
  });

  test("preserves input order among equal values (stable), matching sort+slice", () => {
    // Distinguish equal-valued items by an id to observe ordering.
    const items = [
      { v: 5, id: "a" },
      { v: 5, id: "b" },
      { v: 3, id: "c" },
      { v: 5, id: "d" },
      { v: 3, id: "e" },
    ];
    const result = topKByDescending(items, 3, (x) => x.v);
    // The three 5s in original order.
    expect(result.map((x) => x.id)).toEqual(["a", "b", "d"]);
    expect(result).toEqual(fullSortTopK(items, 3, (x) => x.v));
  });

  test("matches full-sort-then-slice on boundary ties", () => {
    // Two items share the boundary (k-th) value; the earlier one must win.
    const items = [
      { v: 10, id: "x" },
      { v: 7, id: "boundary-first" },
      { v: 7, id: "boundary-second" },
      { v: 4, id: "z" },
    ];
    const result = topKByDescending(items, 2, (x) => x.v);
    expect(result.map((x) => x.id)).toEqual(["x", "boundary-first"]);
    expect(result).toEqual(fullSortTopK(items, 2, (x) => x.v));
  });

  test("agrees with the reference on a larger mixed dataset", () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ v: (i * 37) % 50, i }));
    for (const k of [1, 5, 10, 50, 199, 200, 500]) {
      expect(topKByDescending(items, k, (x) => x.v)).toEqual(fullSortTopK(items, k, (x) => x.v));
    }
  });
});
