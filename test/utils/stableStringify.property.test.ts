import { describe, test } from "bun:test";
import fc from "fast-check";
import { stableStringify } from "../../src/utils/stableStringify";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Arbitrary JSON-compatible values: primitives, arrays, and nested objects.
const jsonValue = fc.jsonValue();

/**
 * Deep-clone a JSON value while reversing the key order of every object. Array
 * order is preserved (it is meaningful). This exercises the whole point of
 * stableStringify: two objects that differ only in key insertion order must
 * serialize identically.
 */
const reverseKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(reverseKeys);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    return Object.fromEntries(entries.map(([k, v]) => [k, reverseKeys(v)]));
  }
  return value;
};

describe("stableStringify (property-based)", () => {
  test("is insensitive to object key ordering", () => {
    fc.assert(
      fc.property(
        jsonValue,
        (value) => stableStringify(value) === stableStringify(reverseKeys(value)),
      ),
      RUN_OPTIONS,
    );
  });

  test("output is always valid JSON that parses back to an equal canonical form", () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        const serialized = stableStringify(value);
        // Re-canonicalizing the round-tripped value must be a fixed point: the
        // canonical form is idempotent under parse ∘ stringify.
        return stableStringify(JSON.parse(serialized)) === serialized;
      }),
      RUN_OPTIONS,
    );
  });

  test("agrees with JSON.stringify on values that contain no objects", () => {
    // Without objects there is nothing to reorder, so the canonical form must
    // coincide exactly with the platform serializer.
    const objectFree = fc.oneof(
      fc.constant(null),
      fc.boolean(),
      fc.integer(),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.string(),
      fc.array(fc.oneof(fc.integer(), fc.string(), fc.boolean())),
    );
    fc.assert(
      fc.property(objectFree, (value) => stableStringify(value) === JSON.stringify(value)),
      RUN_OPTIONS,
    );
  });
});
