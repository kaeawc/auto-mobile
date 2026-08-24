import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  extractCalendarFromLocale,
  normalizeSettingValue,
  normalizeTimeFormat,
  parseBooleanSetting,
  parseLocaleList,
} from "../../../../src/features/utility/system-configuration/parsing";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const anyValue = fc.option(fc.string({ maxLength: 24 }), { nil: null });
const surroundWithWhitespace = (core: string): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.string({ unit: fc.constantFrom(" ", "\t", "\n"), maxLength: 3 }),
      fc.string({ unit: fc.constantFrom(" ", "\t", "\n"), maxLength: 3 }),
    )
    .map(([pre, post]) => `${pre}${core}${post}`);

describe("normalizeSettingValue (property-based)", () => {
  test("returns null or a non-empty, trimmed, non-sentinel string (totality)", () => {
    fc.assert(
      fc.property(anyValue, (v) => {
        const r = normalizeSettingValue(v);
        return r === null || (r.length > 0 && r === r.trim() && r !== "null" && r !== "undefined");
      }),
      RUN_OPTIONS,
    );
  });

  test("is idempotent", () => {
    fc.assert(
      fc.property(
        anyValue,
        (v) => normalizeSettingValue(normalizeSettingValue(v)) === normalizeSettingValue(v),
      ),
      RUN_OPTIONS,
    );
  });

  test("maps blank and sentinel strings (any surrounding whitespace) to null", () => {
    const sentinel = fc.constantFrom("", "null", "undefined").chain(surroundWithWhitespace);
    fc.assert(
      fc.property(sentinel, (s) => normalizeSettingValue(s) === null),
      RUN_OPTIONS,
    );
  });
});

describe("normalizeTimeFormat (property-based)", () => {
  test('only ever returns "12", "24", or null', () => {
    fc.assert(
      fc.property(anyValue, (v) => {
        const r = normalizeTimeFormat(v);
        return r === "12" || r === "24" || r === null;
      }),
      RUN_OPTIONS,
    );
  });

  test('accepts "12"/"24" with surrounding whitespace and rejects other tokens', () => {
    const valid = fc.constantFrom("12", "24");
    const invalid = fc.constantFrom("1", "2", "13", "0", "24h", "twelve", "");
    fc.assert(
      fc.property(
        valid,
        invalid,
        (good, bad) =>
          normalizeTimeFormat(` ${good} `) === good && normalizeTimeFormat(bad) === null,
      ),
      RUN_OPTIONS,
    );
  });
});

describe("parseBooleanSetting (property-based)", () => {
  const mixedCase = (word: string): fc.Arbitrary<string> =>
    fc.array(fc.boolean(), { minLength: word.length, maxLength: word.length }).map((bits) =>
      word
        .split("")
        .map((ch, i) => (bits[i] ? ch.toUpperCase() : ch))
        .join(""),
    );

  test("only ever returns true, false, or null", () => {
    fc.assert(
      fc.property(anyValue, (v) => {
        const r = parseBooleanSetting(v);
        return r === true || r === false || r === null;
      }),
      RUN_OPTIONS,
    );
  });

  test("parses 1/true as true and 0/false as false, case- and whitespace-insensitively", () => {
    fc.assert(
      fc.property(
        fc.oneof(mixedCase("true"), fc.constant("1")),
        fc.oneof(mixedCase("false"), fc.constant("0")),
        (t, f) => parseBooleanSetting(` ${t} `) === true && parseBooleanSetting(` ${f} `) === false,
      ),
      RUN_OPTIONS,
    );
  });

  test("returns null for unrelated tokens", () => {
    const other = fc.constantFrom("yes", "no", "2", "enabled", "", "truthy", "t", "f");
    fc.assert(
      fc.property(other, (v) => parseBooleanSetting(v) === null),
      RUN_OPTIONS,
    );
  });
});

describe("parseLocaleList (property-based)", () => {
  const localeToken = fc.string({
    unit: fc.constantFrom("e", "n", "U", "S", "f", "r", "-", " "),
    maxLength: 8,
  });

  test("returns null or a non-empty, comma-free, trimmed primary locale", () => {
    fc.assert(
      fc.property(fc.array(localeToken, { maxLength: 5 }), (tokens) => {
        const r = parseLocaleList(tokens.join(","));
        return r === null || (r.length > 0 && !r.includes(",") && r === r.trim());
      }),
      RUN_OPTIONS,
    );
  });

  test("selects the trimmed first non-empty segment", () => {
    fc.assert(
      fc.property(fc.array(localeToken, { minLength: 1, maxLength: 5 }), (tokens) => {
        const expectedPrimary = tokens[0]?.trim();
        const r = parseLocaleList(tokens.join(","));
        return expectedPrimary ? r === expectedPrimary : r === null || r.length > 0;
      }),
      RUN_OPTIONS,
    );
  });

  test("is idempotent", () => {
    fc.assert(
      fc.property(fc.array(localeToken, { maxLength: 5 }), (tokens) => {
        const once = parseLocaleList(tokens.join(","));
        return parseLocaleList(once) === once;
      }),
      RUN_OPTIONS,
    );
  });
});

describe("extractCalendarFromLocale (property-based)", () => {
  // A single calendar-id segment, length > 2 so the `-u-ca-` parser collects it.
  const calId = fc.string({
    unit: fc.constantFrom("a", "b", "g", "r", "0", "9"),
    minLength: 3,
    maxLength: 8,
  });

  test("never throws — returns null or a string — for arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (locale) => {
        const r = extractCalendarFromLocale(locale);
        return r === null || typeof r === "string";
      }),
      RUN_OPTIONS,
    );
  });

  test("round-trips a calendar id from the @calendar= keyword form", () => {
    fc.assert(
      fc.property(calId, (cal) => extractCalendarFromLocale(`en-US@calendar=${cal}`) === cal),
      RUN_OPTIONS,
    );
  });

  test("round-trips a calendar id from the -u-ca- extension form", () => {
    fc.assert(
      fc.property(calId, (cal) => extractCalendarFromLocale(`en-US-u-ca-${cal}`) === cal),
      RUN_OPTIONS,
    );
  });

  test("the @calendar= keyword wins over a -u-ca- extension", () => {
    fc.assert(
      fc.property(
        calId,
        calId,
        (viaExt, viaKeyword) =>
          extractCalendarFromLocale(`und-u-ca-${viaExt}@calendar=${viaKeyword}`) === viaKeyword,
      ),
      RUN_OPTIONS,
    );
  });

  test("a locale with neither marker yields null", () => {
    const plainLocale = fc
      .tuple(
        fc.string({ unit: fc.constantFrom("e", "n", "f", "r"), minLength: 2, maxLength: 2 }),
        fc.string({ unit: fc.constantFrom("U", "S", "G", "B"), minLength: 2, maxLength: 2 }),
      )
      .map(([lang, region]) => `${lang}-${region}`);
    fc.assert(
      fc.property(plainLocale, (locale) => extractCalendarFromLocale(locale) === null),
      RUN_OPTIONS,
    );
  });
});
