import { describe, test } from "bun:test";
import fc from "fast-check";
import { outputLooksLikeShellFailure } from "../../../src/utils/android-cmdline-tools/shellOutputHeuristics";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Independent oracle mirroring the module's heuristic.
const oracle = (stdout: string, stderr: string): boolean => {
  const combined = `${stdout}\n${stderr}`.trim();
  return combined ? /exception|error:/i.test(combined) : false;
};

const text = fc.string({ maxLength: 24 });
const whitespace = fc.string({ unit: fc.constantFrom(" ", "\t", "\n"), maxLength: 4 });
const failureMarker = fc.constantFrom(
  "Exception",
  "exception",
  "NullPointerException",
  "error:",
  "ERROR:",
);
const benign = fc.constantFrom(
  "Success",
  "OK",
  "done",
  "error occurred",
  "no errors found",
  "warning: low battery",
  "Broadcast completed",
);

describe("outputLooksLikeShellFailure (property-based)", () => {
  test("is total (a boolean) for arbitrary output", () => {
    fc.assert(
      fc.property(text, text, (o, e) => typeof outputLooksLikeShellFailure(o, e) === "boolean"),
      RUN_OPTIONS,
    );
  });

  test("agrees with the exception|error: heuristic oracle", () => {
    fc.assert(
      fc.property(text, text, (o, e) => outputLooksLikeShellFailure(o, e) === oracle(o, e)),
      RUN_OPTIONS,
    );
  });

  test("whitespace-only (or empty) output is never a failure", () => {
    fc.assert(
      fc.property(whitespace, whitespace, (o, e) => outputLooksLikeShellFailure(o, e) === false),
      RUN_OPTIONS,
    );
  });

  test("a failure marker in either stream flags failure (symmetric)", () => {
    fc.assert(
      fc.property(failureMarker, text, (marker, other) => {
        return (
          outputLooksLikeShellFailure(`${other}${marker}`, "") &&
          outputLooksLikeShellFailure("", `${other}${marker}`)
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("benign output (including a plain 'error' without a colon) is not a failure", () => {
    fc.assert(
      fc.property(benign, benign, (o, e) => outputLooksLikeShellFailure(o, e) === false),
      RUN_OPTIONS,
    );
  });
});
