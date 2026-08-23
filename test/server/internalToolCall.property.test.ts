import { describe, test } from "bun:test";
import fc from "fast-check";
import { INTERNAL_NO_DIFF_PARAM, markInternalToolCall } from "../../src/server/internalToolCall";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const args = fc.dictionary(fc.string({ maxLength: 6 }), fc.jsonValue(), {
  maxKeys: 5,
}) as fc.Arbitrary<Record<string, unknown>>;

describe("markInternalToolCall (property-based)", () => {
  test("returns a new object carrying the marker set to true", () => {
    fc.assert(
      fc.property(args, (a) => {
        const marked = markInternalToolCall(a);
        return marked !== a && marked[INTERNAL_NO_DIFF_PARAM] === true;
      }),
      RUN_OPTIONS,
    );
  });

  test("never mutates the input", () => {
    fc.assert(
      fc.property(args, (a) => {
        const before = JSON.stringify(a);
        markInternalToolCall(a);
        return JSON.stringify(a) === before;
      }),
      RUN_OPTIONS,
    );
  });

  test("preserves every original entry except the marker, which it forces true", () => {
    fc.assert(
      fc.property(args, (a) => {
        const marked = markInternalToolCall(a);
        const preserved = Object.keys(a).every(
          (k) => k === INTERNAL_NO_DIFF_PARAM || marked[k] === a[k],
        );
        return preserved && marked[INTERNAL_NO_DIFF_PARAM] === true;
      }),
      RUN_OPTIONS,
    );
  });

  test("adds exactly the marker key to the key set", () => {
    fc.assert(
      fc.property(args, (a) => {
        const marked = markInternalToolCall(a);
        const expected = new Set([...Object.keys(a), INTERNAL_NO_DIFF_PARAM]);
        const actual = new Set(Object.keys(marked));
        return actual.size === expected.size && [...actual].every((k) => expected.has(k));
      }),
      RUN_OPTIONS,
    );
  });

  test("overrides a pre-existing marker value to true", () => {
    fc.assert(
      fc.property(args, fc.oneof(fc.boolean(), fc.string(), fc.integer()), (a, existing) => {
        return (
          markInternalToolCall({ ...a, [INTERNAL_NO_DIFF_PARAM]: existing })[
            INTERNAL_NO_DIFF_PARAM
          ] === true
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("is idempotent", () => {
    fc.assert(
      fc.property(args, (a) => {
        const once = markInternalToolCall(a);
        return JSON.stringify(markInternalToolCall(once)) === JSON.stringify(once);
      }),
      RUN_OPTIONS,
    );
  });
});
