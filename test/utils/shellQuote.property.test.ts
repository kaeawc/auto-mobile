import { describe, test } from "bun:test";
import fc from "fast-check";
import { shellQuote } from "../../src/utils/shellQuote";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Arbitrary strings, deliberately biased toward the characters that make shell
// quoting hard: single quotes, backslashes, and expansion metacharacters.
const shellUnit = fc.oneof(
  fc.constantFrom("'", "\\", "$", "`", '"', " ", "\n", "\t", "*", "?", ";", "|", "&", "(", ")"),
  fc.integer({ min: 0x20, max: 0x7e }).map((code) => String.fromCharCode(code)),
);
const shellHostile = fc.string({ unit: shellUnit, maxLength: 40 });

/**
 * Reference implementation of POSIX quote-removal, restricted to the constructs
 * `shellQuote` can emit: single-quoted spans and backslash-escaped characters.
 * Running the real quoted word through this recovers the original literal, which
 * is exactly the guarantee `shellQuote` must provide to the device shell.
 */
const posixUnquote = (quoted: string): string => {
  let out = "";
  let inSingle = false;
  let i = 0;
  while (i < quoted.length) {
    const c = quoted[i];
    if (inSingle) {
      if (c === "'") {
        inSingle = false;
      } else {
        out += c;
      }
      i += 1;
    } else if (c === "'") {
      inSingle = true;
      i += 1;
    } else if (c === "\\") {
      // Backslash escapes the next character outside of single quotes.
      out += quoted[i + 1] ?? "";
      i += 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
};

describe("shellQuote (property-based)", () => {
  test("a POSIX shell recovers the exact original literal (round-trip)", () => {
    fc.assert(
      fc.property(shellHostile, (value) => posixUnquote(shellQuote(value)) === value),
      RUN_OPTIONS,
    );
  });

  test("the result is always wrapped in single quotes", () => {
    fc.assert(
      fc.property(shellHostile, (value) => {
        const quoted = shellQuote(value);
        return quoted.startsWith("'") && quoted.endsWith("'") && quoted.length >= 2;
      }),
      RUN_OPTIONS,
    );
  });

  test("adjacent quoted words concatenate to the joined literal", () => {
    // POSIX joins directly-adjacent quoted words into one literal, so quoting the
    // parts and concatenating must be indistinguishable from quoting the whole.
    fc.assert(
      fc.property(
        shellHostile,
        shellHostile,
        (a, b) => posixUnquote(shellQuote(a) + shellQuote(b)) === a + b,
      ),
      RUN_OPTIONS,
    );
  });
});
