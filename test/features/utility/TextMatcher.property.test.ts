import { describe, test } from "bun:test";
import fc from "fast-check";
import { DefaultTextMatcher, normalizeQuotes } from "../../../src/features/utility/TextMatcher";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// The exact code points normalizeQuotes rewrites, with their ASCII targets.
const SINGLE_QUOTES = ["‘", "’", "‚", "‛", "′", "`", "´"];
const DOUBLE_QUOTES = ["“", "”", "„", "‟", "″", "«", "»"];
const DASHES = ["‐", "‑", "‒", "–", "—", "―"];
const ELLIPSIS = "…";
const SMART_CHARS = [...SINGLE_QUOTES, ...DOUBLE_QUOTES, ...DASHES, ELLIPSIS];

// Exclude backtick (0x60): it is the one ASCII char normalizeQuotes rewrites (→ '),
// so it must stay out of the "smart-char-free ASCII" generator.
const asciiChar = fc
  .integer({ min: 0x20, max: 0x7e })
  .filter((c) => c !== 0x60)
  .map((c) => String.fromCharCode(c));
const asciiText = fc.string({ unit: asciiChar, maxLength: 24 });
// Text that mixes ASCII with the smart characters, so normalization actually fires.
const mixedText = fc.string({
  unit: fc.oneof(asciiChar, fc.constantFrom(...SMART_CHARS)),
  maxLength: 24,
});

const matcher = new DefaultTextMatcher();

describe("normalizeQuotes (property-based)", () => {
  test("is idempotent", () => {
    fc.assert(
      fc.property(mixedText, (t) => normalizeQuotes(normalizeQuotes(t)) === normalizeQuotes(t)),
      RUN_OPTIONS,
    );
  });

  test("leaves no smart character in the output", () => {
    fc.assert(
      fc.property(mixedText, (t) => {
        const out = normalizeQuotes(t);
        return SMART_CHARS.every((c) => !out.includes(c));
      }),
      RUN_OPTIONS,
    );
  });

  test("is the identity on smart-char-free ASCII text", () => {
    fc.assert(
      fc.property(asciiText, (t) => normalizeQuotes(t) === t),
      RUN_OPTIONS,
    );
  });

  test("never shrinks the text (ellipsis expands 1->3, all else 1->1)", () => {
    fc.assert(
      fc.property(mixedText, (t) => normalizeQuotes(t).length >= t.length),
      RUN_OPTIONS,
    );
  });

  test("maps each smart character to its ASCII target", () => {
    const cases = fc.oneof(
      fc.constantFrom(...SINGLE_QUOTES).map((c) => [c, "'"] as const),
      fc.constantFrom(...DOUBLE_QUOTES).map((c) => [c, '"'] as const),
      fc.constantFrom(...DASHES).map((c) => [c, "-"] as const),
      fc.constant([ELLIPSIS, "..."] as const),
    );
    fc.assert(
      fc.property(cases, ([smart, ascii]) => normalizeQuotes(smart) === ascii),
      RUN_OPTIONS,
    );
  });
});

describe("DefaultTextMatcher.partialTextMatch (property-based)", () => {
  test("is symmetric", () => {
    fc.assert(
      fc.property(
        mixedText,
        mixedText,
        fc.boolean(),
        (a, b, cs) => matcher.partialTextMatch(a, b, cs) === matcher.partialTextMatch(b, a, cs),
      ),
      RUN_OPTIONS,
    );
  });

  test("is reflexive for non-empty text", () => {
    fc.assert(
      fc.property(
        mixedText.filter((s) => s.length > 0),
        fc.boolean(),
        (a, cs) => matcher.partialTextMatch(a, a, cs),
      ),
      RUN_OPTIONS,
    );
  });

  test("an empty operand never matches", () => {
    fc.assert(
      fc.property(
        mixedText,
        (a) => !matcher.partialTextMatch(a, "") && !matcher.partialTextMatch("", a),
      ),
      RUN_OPTIONS,
    );
  });

  test("case-insensitive mode matches across letter casing", () => {
    const letters = fc.string({
      unit: fc.constantFrom("a", "B", "c", "D", "e"),
      minLength: 1,
      maxLength: 10,
    });
    fc.assert(
      fc.property(letters, (a) => matcher.partialTextMatch(a, a.toUpperCase(), false)),
      RUN_OPTIONS,
    );
  });

  test("folds a smart apostrophe onto its straight equivalent", () => {
    fc.assert(
      fc.property(asciiText, asciiText, (pre, post) => {
        const straight = `${pre}'${post}`;
        const smart = `${pre}’${post}`;
        return matcher.partialTextMatch(straight, smart, true);
      }),
      RUN_OPTIONS,
    );
  });
});

describe("DefaultTextMatcher.createTextMatcher (property-based)", () => {
  test("an empty search text yields a matcher that never matches", () => {
    fc.assert(
      fc.property(
        fc.option(asciiText, { nil: undefined }),
        (input) => matcher.createTextMatcher("")(input) === false,
      ),
      RUN_OPTIONS,
    );
  });

  test("a partial matcher agrees with normalized substring containment", () => {
    fc.assert(
      fc.property(
        mixedText.filter((s) => s.length > 0),
        mixedText,
        (text, input) => {
          const fn = matcher.createTextMatcher(text, true, false);
          const expected = normalizeQuotes(input)
            .toLowerCase()
            .includes(normalizeQuotes(text).toLowerCase());
          return fn(input) === expected;
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("a partial matcher matches its own (non-empty) search text", () => {
    fc.assert(
      fc.property(
        mixedText.filter((s) => s.length > 0),
        (text) => matcher.createTextMatcher(text, true, false)(text),
      ),
      RUN_OPTIONS,
    );
  });
});
