import { describe, test } from "bun:test";
import fc from "fast-check";
import { createExecResult } from "../../src/utils/execResult";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Well-formed UTF-16 (no lone surrogates) so Buffer utf-8 round-trips exactly.
const text = fc
  .array(
    fc.integer({ min: 0, max: 0x10ffff }).filter((cp) => cp < 0xd800 || cp > 0xdfff),
    { maxLength: 100 },
  )
  .map((cps) => String.fromCodePoint(...cps));

describe("createExecResult (property-based)", () => {
  test("string inputs pass through unchanged on stdout/stderr", () => {
    fc.assert(
      fc.property(text, text, (out, err) => {
        const result = createExecResult(out, err);
        return result.stdout === out && result.stderr === err;
      }),
      RUN_OPTIONS,
    );
  });

  test("Buffer inputs are decoded and round-trip through utf-8", () => {
    fc.assert(
      fc.property(text, text, (out, err) => {
        const result = createExecResult(Buffer.from(out, "utf8"), Buffer.from(err, "utf8"));
        return result.stdout === out && result.stderr === err;
      }),
      RUN_OPTIONS,
    );
  });

  test("toString() and trim() are stdout-derived", () => {
    fc.assert(
      fc.property(text, text, (out, err) => {
        const result = createExecResult(out, err);
        return result.toString() === result.stdout && result.trim() === result.stdout.trim();
      }),
      RUN_OPTIONS,
    );
  });

  test("includes() agrees with String.prototype.includes on stdout", () => {
    fc.assert(
      fc.property(text, text, fc.string({ maxLength: 8 }), (out, err, needle) => {
        const result = createExecResult(out, err);
        return result.includes(needle) === result.stdout.includes(needle);
      }),
      RUN_OPTIONS,
    );
  });

  test("a substring of stdout is always reported as included", () => {
    fc.assert(
      fc.property(text, text, (out, err) => {
        const result = createExecResult(out, err);
        // Every prefix of stdout is a substring, so includes() must accept it.
        return result.includes(out.slice(0, Math.floor(out.length / 2)));
      }),
      RUN_OPTIONS,
    );
  });
});
