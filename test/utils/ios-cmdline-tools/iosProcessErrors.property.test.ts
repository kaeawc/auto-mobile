import { describe, test } from "bun:test";
import fc from "fast-check";
import { isProcessAlreadyGoneError } from "../../../src/utils/ios-cmdline-tools/iosProcessErrors";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const positivePhrase = fc.constantFrom(
  "no such process",
  "found nothing to terminate",
  "process not running",
  "process is not running",
);
// Realistic messages that must NOT match — device-scoped "not running", unrelated
// failures, and the devicectl ESRCH code (OR-ed in at the call site, not here).
const nonMatching = fc.constantFrom(
  "The device is not connected",
  "Unable to launch: device locked",
  "Permission denied",
  "Device not running",
  "CoreDevice not running",
  "Operation timed out",
  "An error occurred",
  "NSPOSIXErrorDomain error 3",
);
const mixedCase = (w: string): fc.Arbitrary<string> =>
  fc.array(fc.boolean(), { minLength: w.length, maxLength: w.length }).map((bits) =>
    w
      .split("")
      .map((ch, i) => (bits[i] ? ch.toUpperCase() : ch))
      .join(""),
  );
const filler = fc.string({ maxLength: 12 });

describe("isProcessAlreadyGoneError (property-based)", () => {
  test("is total (a boolean) for any string", () => {
    fc.assert(
      fc.property(fc.string(), (m) => typeof isProcessAlreadyGoneError(m) === "boolean"),
      RUN_OPTIONS,
    );
  });

  test("is case-insensitive", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        (m) =>
          isProcessAlreadyGoneError(m) === isProcessAlreadyGoneError(m.toUpperCase()) &&
          isProcessAlreadyGoneError(m) === isProcessAlreadyGoneError(m.toLowerCase()),
      ),
      RUN_OPTIONS,
    );
  });

  test("matches any message containing a shared process-gone phrase (any casing)", () => {
    fc.assert(
      fc.property(positivePhrase.chain(mixedCase), filler, filler, (phrase, pre, post) =>
        isProcessAlreadyGoneError(`${pre}${phrase}${post}`),
      ),
      RUN_OPTIONS,
    );
  });

  test("does not match device-scoped or unrelated failures", () => {
    fc.assert(
      fc.property(nonMatching, (m) => isProcessAlreadyGoneError(m) === false),
      RUN_OPTIONS,
    );
  });
});
