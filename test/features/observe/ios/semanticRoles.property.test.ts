import { describe, test } from "bun:test";
import fc from "fast-check";
import { hasIosHeaderTrait } from "../../../../src/features/observe/ios/semanticRoles";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const TRAITS_KEY = "sdk.accessibilityTraits";
// Trait tokens without commas (the value is comma-joined). Case matters — the
// check is exact "header", so "HEADER"/"headers"/"xheader" must NOT count.
const traitToken = fc.constantFrom(
  "button",
  "header",
  "link",
  " header ",
  "HEADER",
  "headers",
  "xheader",
  "",
);
const traitsString = fc.array(traitToken, { maxLength: 6 }).map((ts) => ts.join(","));

describe("hasIosHeaderTrait (property-based)", () => {
  test("is total and false for any non-object input", () => {
    const nonObject = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.string(),
      fc.integer(),
      fc.boolean(),
    );
    fc.assert(
      fc.property(nonObject, (v) => hasIosHeaderTrait(v) === false),
      RUN_OPTIONS,
    );
  });

  test("matches an independent comma-segment oracle (exact, trimmed 'header')", () => {
    fc.assert(
      fc.property(traitsString, (traits) => {
        const expected = traits.split(",").some((t) => t.trim() === "header");
        return hasIosHeaderTrait({ [TRAITS_KEY]: traits }) === expected;
      }),
      RUN_OPTIONS,
    );
  });

  test("is false when the traits key is missing or non-string", () => {
    const badTraits = fc.oneof(
      fc.constant(undefined),
      fc.integer(),
      fc.array(fc.string()),
      fc.constant({ header: true }),
    );
    fc.assert(
      fc.property(
        badTraits,
        (traits) =>
          hasIosHeaderTrait({ [TRAITS_KEY]: traits }) === false &&
          hasIosHeaderTrait({ other: "header" }) === false,
      ),
      RUN_OPTIONS,
    );
  });

  test("a 'header' segment (with surrounding whitespace) is always detected", () => {
    const withHeader = fc
      .array(traitToken, { maxLength: 4 })
      .chain((rest) =>
        fc
          .constantFrom("header", " header ", "header ", " header")
          .map((h) => [...rest, h].join(",")),
      );
    fc.assert(
      fc.property(withHeader, (traits) => hasIosHeaderTrait({ [TRAITS_KEY]: traits })),
      RUN_OPTIONS,
    );
  });
});
