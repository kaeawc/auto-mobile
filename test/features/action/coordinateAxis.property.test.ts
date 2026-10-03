import { test } from "bun:test";
import fc from "fast-check";
import {
  normalizedAxis,
  translatedNormalizedAxis,
} from "../../../src/features/action/coordinateAxis";

const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

test("normalized positive extents are half-open including the inclusive endpoint", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 1_000_000_000 }),
      fc.integer({ min: 0, max: 1000 }),
      (size, numerator) => {
        const result = normalizedAxis(numerator / 1000, size);
        return result >= 0 && result < size;
      },
    ),
    RUN_OPTIONS,
  );
});

test("translated endpoints and their nearest interior values stay half-open", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
      fc.integer({ min: 1, max: 1_000_000_000 }),
      fc.constantFrom(1, 1 - Number.EPSILON / 2, 1 - Number.EPSILON),
      (start, size, value) => {
        const end = start + size;
        const result = translatedNormalizedAxis(value, start, end);
        return result >= start && result < end;
      },
    ),
    RUN_OPTIONS,
  );
});
