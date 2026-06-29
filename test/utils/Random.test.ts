import { describe, expect, test } from "bun:test";
import { CryptoRandom } from "../../src/utils/Random";
import { SeededRandom } from "../fakes/SeededRandom";

describe("CryptoRandom", function() {
  test("next returns values in [0, 1)", function() {
    const random = new CryptoRandom();
    for (let i = 0; i < 100; i++) {
      const value = random.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test("pick returns one of the provided items", function() {
    expect(["a", "b", "c"]).toContain(new CryptoRandom().pick(["a", "b", "c"]));
  });
});

describe("SeededRandom", function() {
  test("same seeds produce the same sequence", function() {
    const first = new SeededRandom(42);
    const second = new SeededRandom(42);

    expect(Array.from({ length: 10 }, () => first.next())).toEqual(
      Array.from({ length: 10 }, () => second.next())
    );
  });

  test("reseed restarts the sequence", function() {
    const random = new SeededRandom(7);
    const first = random.next();

    random.next();
    random.reseed(7);

    expect(random.next()).toBe(first);
  });

  test("pick is deterministic for a given seed", function() {
    const items = ["a", "b", "c", "d"];
    expect(new SeededRandom(100).pick(items)).toBe(new SeededRandom(100).pick(items));
  });
});
