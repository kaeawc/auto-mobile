import { describe, test } from "bun:test";
import fc from "fast-check";
import { firstFlagValue } from "../../src/utils/cliArgs";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Flag names are `--` followed by letters — no `=` or whitespace, matching real
// argv flags and keeping the inline `--flag=value` split unambiguous.
const flagName = fc
  .array(fc.constantFrom("a", "b", "c", "d", "e", "f"), { minLength: 1, maxLength: 6 })
  .map((chars) => `--${chars.join("")}`);

// A value usable in the space-separated form: non-empty and not itself a flag.
const spaceValue = fc.string({ minLength: 1, maxLength: 16 }).filter((v) => !v.startsWith("--"));

describe("firstFlagValue (property-based)", () => {
  test("never throws and returns a string or undefined for arbitrary argv", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.array(fc.string()), (args, flags) => {
        const result = firstFlagValue(args, flags);
        return result === undefined || typeof result === "string";
      }),
      RUN_OPTIONS,
    );
  });

  test("recovers the inline value for any value (round-trip)", () => {
    // The inline form has no flag-lookalike restriction, so ANY value round-trips.
    fc.assert(
      fc.property(flagName, fc.string({ maxLength: 24 }), (flag, value) => {
        return firstFlagValue([`${flag}=${value}`], [flag]) === value;
      }),
      RUN_OPTIONS,
    );
  });

  test("recovers the space-separated value when it is a non-flag token", () => {
    fc.assert(
      fc.property(flagName, spaceValue, (flag, value) => {
        return firstFlagValue([flag, value], [flag]) === value;
      }),
      RUN_OPTIONS,
    );
  });

  test("a flag with no value, or followed by another flag, yields undefined", () => {
    fc.assert(
      fc.property(flagName, flagName, (flag, other) => {
        const loneAtEnd = firstFlagValue([flag], [flag]) === undefined;
        const followedByFlag = firstFlagValue([flag, other], [flag]) === undefined;
        return loneAtEnd && followedByFlag;
      }),
      RUN_OPTIONS,
    );
  });

  test("argv with no matching flag yields undefined", () => {
    // Prefixing every token with "p" guarantees none is a `--flag` or `--flag=…`.
    const positionals = fc.array(
      fc.string({ maxLength: 12 }).map((t) => `p${t}`),
      { maxLength: 10 },
    );
    fc.assert(
      fc.property(
        positionals,
        fc.array(flagName, { minLength: 1, maxLength: 3 }),
        (args, flags) => {
          return firstFlagValue(args, flags) === undefined;
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("the first matching flag in argv wins", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), fc.string({ maxLength: 12 }), (v1, v2) => {
        const result = firstFlagValue(["--one=" + v1, "--two=" + v2], ["--one", "--two"]);
        return result === v1;
      }),
      RUN_OPTIONS,
    );
  });
});
