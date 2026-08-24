import { describe, expect, test } from "bun:test";
import type { Random } from "../../src/utils/Random";

export const runRandomContract = (description: string, makeRandom: () => Random): void => {
  describe(`Random contract: ${description}`, function () {
    test("next returns values in [0, 1)", function () {
      const random = makeRandom();
      for (let i = 0; i < 100; i++) {
        const value = random.next();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    });

    test("pick returns one input item and rejects empty arrays", function () {
      const random = makeRandom();
      expect(["a", "b", "c"]).toContain(random.pick(["a", "b", "c"]));
      expect(() => random.pick([])).toThrow(/empty/);
    });

    test("pick returns the sole element of a single-item array", function () {
      const random = makeRandom();
      expect(random.pick(["only"])).toBe("only");
    });
  });
};
