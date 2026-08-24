import { describe, test } from "bun:test";
import fc from "fast-check";
import type { ObserveResult } from "../../../src/models";
import {
  appendObserveError,
  type ObserveError,
  type ObservePhase,
} from "../../../src/features/observe/ObserveError";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const PHASES: ObservePhase[] = [
  "screenSize",
  "systemInsets",
  "rotation",
  "wakefulness",
  "backStack",
  "viewHierarchy",
  "rawViewHierarchy",
  "intentChooser",
  "activeWindow",
  "screenshot",
  "performanceAudit",
  "accessibilityAudit",
  "accessibilityState",
  "predictiveUI",
  "cache",
  "critical",
];
const observeError: fc.Arbitrary<ObserveError> = fc.record(
  {
    phase: fc.constantFrom(...PHASES),
    message: fc.string({ maxLength: 20 }),
    cause: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
  },
  { requiredKeys: ["phase", "message"] },
);
// A non-empty legacy `error` string (the `if (result.error)` migration is truthy-gated), or none.
const legacy = fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: undefined });
const errors = fc.array(observeError, { minLength: 1, maxLength: 6 });

const freshResult = (legacyError: string | undefined): ObserveResult =>
  (legacyError !== undefined ? { error: legacyError } : {}) as ObserveResult;

describe("appendObserveError (property-based)", () => {
  test("result.error is always the '; '-join of every accumulated message", () => {
    fc.assert(
      fc.property(legacy, errors, (legacyError, errs) => {
        const result = freshResult(legacyError);
        errs.forEach((e) => appendObserveError(result, e));
        return result.error === result.errors!.map((e) => e.message).join("; ");
      }),
      RUN_OPTIONS,
    );
  });

  test("the appended errors are exactly the (migrated legacy, then each err) sequence", () => {
    fc.assert(
      fc.property(legacy, errors, (legacyError, errs) => {
        const result = freshResult(legacyError);
        errs.forEach((e) => appendObserveError(result, e));
        const expected = (legacyError !== undefined ? [legacyError] : []).concat(
          errs.map((e) => e.message),
        );
        return (
          result.errors!.length === expected.length &&
          result.errors!.every((e, i) => e.message === expected[i])
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("a pre-existing legacy error string is migrated once, as a leading 'critical' entry", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 12 }), errors, (legacyError, errs) => {
        const result = freshResult(legacyError);
        errs.forEach((e) => appendObserveError(result, e));
        const first = result.errors![0];
        // Only one migrated entry, at the front, and never re-migrated on later appends.
        const onlyOneCritical =
          result.errors!.filter((e) => e.phase === "critical" && e.message === legacyError)
            .length >= 1;
        return (
          first.phase === "critical" &&
          first.message === legacyError &&
          onlyOneCritical &&
          result.errors!.length === errs.length + 1
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("the errors array grows by exactly one per append (monotonic accumulation)", () => {
    fc.assert(
      fc.property(errors, (errs) => {
        const result = freshResult(undefined);
        return errs.every((e, i) => {
          appendObserveError(result, e);
          return result.errors!.length === i + 1 && result.errors![i] === e;
        });
      }),
      RUN_OPTIONS,
    );
  });
});
