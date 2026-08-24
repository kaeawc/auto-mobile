import { describe, test } from "bun:test";
import fc from "fast-check";
import { normalizeIdentifier, normalizeToolArgs } from "../../src/utils/predictionUtils";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Identifier-ish text: letters (mixed case), digits, spaces, and separators.
const identChar = fc.constantFrom("a", "B", "c", "D", "3", "_", "-", ".", " ", "\t");
const identifier = fc.string({ unit: identChar, maxLength: 20 });

// Tool-arg objects whose keys are never the stripped ones (deviceId/sessionUuid).
const argKey = fc
  .string({ minLength: 1, maxLength: 8 })
  .filter((k) => k !== "deviceId" && k !== "sessionUuid");
const toolArgs = fc.dictionary(argKey, fc.jsonValue(), { minKeys: 1, maxKeys: 6 });

describe("normalizeIdentifier (property-based)", () => {
  test("is idempotent", () => {
    fc.assert(
      fc.property(
        identifier,
        (v) => normalizeIdentifier(normalizeIdentifier(v)) === normalizeIdentifier(v),
      ),
      RUN_OPTIONS,
    );
  });

  test("a defined result is fully trimmed and lower-cased", () => {
    fc.assert(
      fc.property(identifier, (v) => {
        const result = normalizeIdentifier(v);
        return (
          result === undefined || (result === result.trim() && result === result.toLowerCase())
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("blank or whitespace-only input normalizes to undefined", () => {
    const blank = fc.string({ unit: fc.constantFrom(" ", "\t", "\n"), maxLength: 8 });
    fc.assert(
      fc.property(
        blank,
        (v) => normalizeIdentifier(v) === undefined && normalizeIdentifier(undefined) === undefined,
      ),
      RUN_OPTIONS,
    );
  });
});

describe("normalizeToolArgs (property-based)", () => {
  test("empty/null/undefined args normalize to the empty string", () => {
    fc.assert(
      fc.property(fc.constantFrom(null, undefined, {}), (args) => normalizeToolArgs(args) === ""),
      RUN_OPTIONS,
    );
  });

  test("deviceId and sessionUuid are ignored", () => {
    fc.assert(
      fc.property(toolArgs, fc.string(), fc.string(), (args, deviceId, sessionUuid) => {
        return normalizeToolArgs({ ...args, deviceId, sessionUuid }) === normalizeToolArgs(args);
      }),
      RUN_OPTIONS,
    );
  });

  test("output is insensitive to key insertion order", () => {
    fc.assert(
      fc.property(toolArgs, (args) => {
        const reordered = Object.fromEntries(Object.entries(args).reverse());
        return normalizeToolArgs(reordered) === normalizeToolArgs(args);
      }),
      RUN_OPTIONS,
    );
  });

  test("output is always the empty string or valid JSON", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 6 }), (args) => {
        const result = normalizeToolArgs(args);
        if (result === "") {
          return true;
        }
        JSON.parse(result);
        return true;
      }),
      RUN_OPTIONS,
    );
  });
});
