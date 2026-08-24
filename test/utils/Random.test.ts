import { describe, expect, test } from "bun:test";
import { SeededRandom } from "../fakes/SeededRandom";

// The CryptoRandom `next()`-range and `pick()` cases that used to live here were
// verbatim duplicates of RandomContract, which runAll.test.ts already runs
// against CryptoRandom (and more strongly — it also asserts `pick([])` throws).
// They were removed to keep the contract the single source of truth.

describe("SeededRandom", function () {
  test("same seeds produce the same sequence", function () {
    const first = new SeededRandom(42);
    const second = new SeededRandom(42);

    expect(Array.from({ length: 10 }, () => first.next())).toEqual(
      Array.from({ length: 10 }, () => second.next()),
    );
  });

  test("reseed restarts the sequence", function () {
    const random = new SeededRandom(7);
    const first = random.next();

    random.next();
    random.reseed(7);

    expect(random.next()).toBe(first);
  });

  test("pick is deterministic for a given seed", function () {
    const items = ["a", "b", "c", "d"];
    expect(new SeededRandom(100).pick(items)).toBe(new SeededRandom(100).pick(items));
  });

  test("degenerate seeds 0, NaN and 1 collapse to the same stream", function () {
    // normalizeSeed = (Math.floor(seed) >>> 0) || 1, so 0 -> 1, NaN -> 0 -> 1,
    // and 1 -> 1: all three seeds yield an IDENTICAL sequence. Compare full
    // 5-value streams (a single value would be a far weaker check).
    const stream = (seed: number): number[] => {
      const random = new SeededRandom(seed);
      return Array.from({ length: 5 }, () => random.next());
    };
    const canonical = stream(1);

    expect(stream(0)).toEqual(canonical);
    expect(stream(Number.NaN)).toEqual(canonical);
  });
});
