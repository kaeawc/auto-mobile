import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  BODY_TRUNCATION_LIMIT,
  boundStructuredField,
  truncateBodyText,
} from "../../src/utils/truncateBodyText";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Arbitrary UTF-16, built from raw code units so it can include lone surrogates
// (malformed input) — exactly the boundary case truncateBodyText must survive.
const anyUtf16 = fc
  .array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 200 })
  .map((codes) => String.fromCharCode(...codes));

// Well-formed UTF-16: every code point is either a BMP non-surrogate or an
// astral character (a valid high+low pair). This is the function's realistic
// domain — telemetry bodies are valid strings. Its guarantee is "never split a
// VALID surrogate pair", so the surrogate property below is asserted over this.
// (Deliberately malformed input — e.g. two adjacent lone high surrogates — is
// out of contract; the function caps such input but does not sanitize it.)
const wellFormedUtf16 = fc
  .array(
    fc.integer({ min: 0, max: 0x10ffff }).filter((cp) => cp < 0xd800 || cp > 0xdfff),
    { maxLength: 200 },
  )
  .map((cps) => String.fromCodePoint(...cps));

const limit = fc.integer({ min: 1, max: 128 });

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

describe("truncateBodyText (property-based)", () => {
  test("never exceeds the limit and is always a prefix of the input", () => {
    fc.assert(
      fc.property(anyUtf16, limit, (text, max) => {
        const result = truncateBodyText(text, max);
        return result !== null && result.length <= max && text.startsWith(result);
      }),
      RUN_OPTIONS,
    );
  });

  test("is idempotent", () => {
    fc.assert(
      fc.property(anyUtf16, limit, (text, max) => {
        const once = truncateBodyText(text, max);
        return truncateBodyText(once, max) === once;
      }),
      RUN_OPTIONS,
    );
  });

  test("never leaves a lone surrogate at the cut, for well-formed input", () => {
    fc.assert(
      fc.property(wellFormedUtf16, limit, (text, max) => {
        const result = truncateBodyText(text, max)!;
        if (result.length === 0) {
          return true;
        }
        const last = result.charCodeAt(result.length - 1);
        if (isHighSurrogate(last)) {
          // A trailing high surrogate is always lone (its mate was past the cut).
          return false;
        }
        if (isLowSurrogate(last)) {
          // A trailing low surrogate is valid only as the tail of a complete pair.
          return result.length >= 2 && isHighSurrogate(result.charCodeAt(result.length - 2));
        }
        return true;
      }),
      RUN_OPTIONS,
    );
  });

  test("returns short-enough text and null unchanged", () => {
    const shortText = fc
      .array(fc.integer({ min: 0x20, max: 0x7e }), { maxLength: BODY_TRUNCATION_LIMIT })
      .map((codes) => String.fromCharCode(...codes));
    fc.assert(
      fc.property(
        shortText,
        (text) => truncateBodyText(text) === text && truncateBodyText(null) === null,
      ),
      RUN_OPTIONS,
    );
  });
});

describe("boundStructuredField (property-based)", () => {
  test("passes small values through by identity and replaces oversized ones with a marker", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.integer({ min: 2, max: 4096 }), (value, max) => {
        const result = boundStructuredField(value, false, max);
        if (value === null || value === undefined) {
          return result === value;
        }
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
          // Unserializable values are passed through untouched by contract.
          return result === value;
        }
        if (serialized.length <= max) {
          return result === value;
        }
        // Over budget: a small, always-valid marker carrying the original size.
        const marker = result as { _truncated?: boolean; bytes?: number };
        return marker._truncated === true && marker.bytes === serialized.length;
      }),
      RUN_OPTIONS,
    );
  });

  test("null and undefined always pass through", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.integer({ min: 1, max: 4096 }), (asJsonString, max) => {
        return (
          boundStructuredField(null, asJsonString, max) === null &&
          boundStructuredField(undefined, asJsonString, max) === undefined
        );
      }),
      RUN_OPTIONS,
    );
  });
});
