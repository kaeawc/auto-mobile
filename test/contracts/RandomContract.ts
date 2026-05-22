import { describe, expect, test } from "bun:test";
import type { Random } from "../../src/utils/Random";

export const runRandomContract = (
  description: string,
  makeRandom: () => Random
): void => {
  describe(`Random contract: ${description}`, function() {
    test("next returns values in [0, 1)", function() {
      const random = makeRandom();
      for (let i = 0; i < 100; i++) {
        const value = random.next();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    });

    test("int returns inclusive integers inside the requested range", function() {
      const random = makeRandom();
      const seen = new Set<number>();
      for (let i = 0; i < 500; i++) {
        const value = random.int(10, 13);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(10);
        expect(value).toBeLessThanOrEqual(13);
        seen.add(value);
      }
      expect(seen.size).toBe(4);
    });

    test("bytes returns the requested number of bytes", function() {
      expect(makeRandom().bytes(16)).toHaveLength(16);
    });

    test("pick returns one input item and rejects empty arrays", function() {
      const random = makeRandom();
      expect(["a", "b", "c"]).toContain(random.pick(["a", "b", "c"]));
      expect(() => random.pick([])).toThrow(/empty/);
    });

    test("shuffle preserves input elements", function() {
      const input = [1, 2, 3, 4, 5];
      const shuffled = makeRandom().shuffle(input);

      expect(shuffled).toHaveLength(input.length);
      expect(shuffled.slice().sort()).toEqual(input);
    });

    test("uuid returns a v4-shaped UUID", function() {
      expect(makeRandom().uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });
};
