import { describe, test } from "bun:test";
import fc from "fast-check";
import { narrowInternalToolEnvelope } from "../../src/server/internalToolPayloads";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const name = fc.constantFrom("swipeOn", "observe");
const objectPayload = fc.dictionary(fc.string({ maxLength: 6 }), fc.jsonValue(), { maxKeys: 4 });
// Envelopes: some carry a valid object structuredContent, some do not.
const envelope = fc.oneof(
  fc.record({ structuredContent: objectPayload }),
  fc.record({ structuredContent: fc.oneof(fc.constant(null), fc.string(), fc.integer()) }),
  fc.record({ other: fc.string() }),
  fc.constant(null),
  fc.constant(undefined),
  fc.string(),
  fc.integer(),
  fc.boolean(),
);

describe("narrowInternalToolEnvelope (property-based)", () => {
  test("is total — returns undefined or an object, never throwing", () => {
    fc.assert(
      fc.property(name, envelope, (n, response) => {
        const r = narrowInternalToolEnvelope(n, response);
        return r === undefined || typeof r === "object";
      }),
      RUN_OPTIONS,
    );
  });

  test("returns the same envelope by identity iff structuredContent is an object", () => {
    fc.assert(
      fc.property(name, envelope, (n, response) => {
        const sc = (response as { structuredContent?: unknown } | null | undefined)
          ?.structuredContent;
        const valid = !!response && typeof response === "object" && !!sc && typeof sc === "object";
        const r = narrowInternalToolEnvelope(n, response);
        return valid ? r === response : r === undefined;
      }),
      RUN_OPTIONS,
    );
  });

  test("null/non-object responses always narrow to undefined", () => {
    const nonObject = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.string(),
      fc.integer(),
      fc.boolean(),
    );
    fc.assert(
      fc.property(
        name,
        nonObject,
        (n, response) => narrowInternalToolEnvelope(n, response) === undefined,
      ),
      RUN_OPTIONS,
    );
  });

  test("the result is independent of the tool name", () => {
    fc.assert(
      fc.property(
        envelope,
        (response) =>
          narrowInternalToolEnvelope("swipeOn", response) ===
          narrowInternalToolEnvelope("observe", response),
      ),
      RUN_OPTIONS,
    );
  });
});
