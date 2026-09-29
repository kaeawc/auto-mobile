import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { INTERNAL_TOOL_PARAM_NAMES } from "../../src/daemon/constants";
import { stripInternalToolParams } from "../../src/server/index";

const RUN_OPTIONS = { seed: 1_234_567, numRuns: 100 } as const;
const internalNames = new Set<string>(INTERNAL_TOOL_PARAM_NAMES);
const valueArb = fc.jsonValue();
const ordinaryArgsArb = fc.dictionary(
  fc.string({ maxLength: 12 }).filter((key) => !internalNames.has(key)),
  valueArb,
  { maxKeys: 8 },
) as fc.Arbitrary<Record<string, unknown>>;
const arbitraryArgsArb = fc.dictionary(fc.string({ maxLength: 12 }), valueArb, {
  maxKeys: 8,
}) as fc.Arbitrary<Record<string, unknown>>;
const internalSubsetArb = fc.subarray(INTERNAL_TOOL_PARAM_NAMES, { maxLength: 5 });

function withInternalParams(
  args: Record<string, unknown>,
  names: readonly string[],
): Record<string, unknown> {
  return Object.assign({}, args, ...names.map((name) => ({ [name]: { nested: [name] } })));
}

describe("stripInternalToolParams (property-based)", () => {
  test("strips every canonical internal key and preserves all other entries", () => {
    fc.assert(
      fc.property(ordinaryArgsArb, internalSubsetArb, (args, names) => {
        const input = withInternalParams(args, names);
        const result = stripInternalToolParams(input) as Record<string, unknown>;
        const expectedKeys = Object.keys(input).filter((key) => !internalNames.has(key));

        expect(Object.keys(result)).toHaveLength(expectedKeys.length);
        for (const key of expectedKeys) {
          expect(Object.hasOwn(result, key)).toBe(true);
          expect(result[key]).toBe(input[key]);
        }
        expect(Object.keys(result).some((key) => internalNames.has(key))).toBe(false);
      }),
      RUN_OPTIONS,
    );
  });

  test("is idempotent", () => {
    fc.assert(
      fc.property(arbitraryArgsArb, internalSubsetArb, (args, names) => {
        const input = withInternalParams(args, names);
        const once = stripInternalToolParams(input);
        const twice = stripInternalToolParams(once);
        expect(twice).toBe(once);
      }),
      RUN_OPTIONS,
    );
  });

  test("does not mutate input and preserves nested values by identity", () => {
    fc.assert(
      fc.property(ordinaryArgsArb, internalSubsetArb, (args, names) => {
        const input = withInternalParams(args, names);
        const before = structuredClone(input);
        const result = stripInternalToolParams(input) as Record<string, unknown>;

        expect(JSON.stringify(input)).toBe(JSON.stringify(before));
        for (const key of Object.keys(args)) {
          expect(result[key]).toBe(input[key]);
        }
        expect(result === input).toBe(names.length === 0);
      }),
      RUN_OPTIONS,
    );
  });
});
