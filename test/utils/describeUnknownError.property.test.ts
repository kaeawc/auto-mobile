import { describe, test } from "bun:test";
import fc from "fast-check";
import { describeUnknownError } from "../../src/utils/describeUnknownError";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

describe("describeUnknownError (property-based)", () => {
  test("always returns a string for any input (totality — its whole purpose)", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => typeof describeUnknownError(value) === "string"),
      RUN_OPTIONS,
    );
  });

  test("primitives stringify exactly like String()", () => {
    const primitive = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.double({ noNaN: true }),
      fc.boolean(),
      fc.bigInt(),
    );
    fc.assert(
      fc.property(primitive, (value) => describeUnknownError(value) === String(value)),
      RUN_OPTIONS,
    );
  });

  test("null and undefined render as their String() form", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, undefined),
        (value) => describeUnknownError(value) === String(value),
      ),
      RUN_OPTIONS,
    );
  });

  test("an Error's rendering starts with its name and contains its message", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (message) => {
        const rendered = describeUnknownError(new Error(message));
        return rendered.startsWith("Error") && rendered.includes(message);
      }),
      RUN_OPTIONS,
    );
  });

  test("a plain object with enumerable keys renders as its JSON serialization", () => {
    const jsonObject = fc.dictionary(fc.string(), fc.jsonValue(), { minKeys: 1, maxKeys: 6 });
    fc.assert(
      fc.property(jsonObject, (obj) => describeUnknownError(obj) === JSON.stringify(obj)),
      RUN_OPTIONS,
    );
  });

  test("an object with no enumerable keys is flagged as such", () => {
    fc.assert(
      fc.property(fc.constant({}), (obj) =>
        describeUnknownError(obj).includes("no enumerable keys"),
      ),
      RUN_OPTIONS,
    );
  });
});
