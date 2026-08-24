import { describe, expect, test } from "bun:test";
import type { IdGenerator } from "../../src/utils/IdGenerator";

/**
 * Shared contract for every {@link IdGenerator}: the one invariant a consumer
 * relies on is that successive `next()` calls never collide. Registering all
 * three implementations (production NodeIdGenerator/CountingIdGenerator and the
 * FakeIdGenerator test double) keeps the fake from drifting into a form that
 * silently re-emits an id it already handed out (issue #4186).
 */
export const runIdGeneratorContract = (
  description: string,
  makeIdGenerator: () => IdGenerator,
): void => {
  describe(`IdGenerator contract: ${description}`, function () {
    test("emits a non-empty id", function () {
      const id = makeIdGenerator().next();

      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });

    test("never repeats an id across many successive calls", function () {
      const generator = makeIdGenerator();
      const seen = new Set<string>();

      for (let i = 0; i < 100; i += 1) {
        seen.add(generator.next());
      }

      expect(seen.size).toBe(100);
    });
  });
};
