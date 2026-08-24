import { describe, it, expect } from "bun:test";
import {
  normalizeSettingValue,
  normalizeTimeFormat,
  parseBooleanSetting,
  parseLocaleList,
  extractCalendarFromLocale,
} from "../../../../src/features/utility/system-configuration/parsing";

describe("normalizeSettingValue", () => {
  const cases: Array<[string, string | null, string | null]> = [
    ["passes through a plain value", "hello", "hello"],
    ["trims surrounding whitespace", "  hello  ", "hello"],
    ["trims a value with inner spaces but keeps them", "  a b  ", "a b"],
    ["maps null to null", null, null],
    ["maps an empty string to null", "", null],
    ["maps whitespace-only to null", "   ", null],
    ["maps the literal 'null' to null", "null", null],
    ["maps the literal 'undefined' to null", "undefined", null],
    ["maps 'null' with surrounding whitespace to null", "  null  ", null],
    ["keeps a case-variant 'NULL' as a value", "NULL", "NULL"],
    ["keeps '0' as a value", "0", "0"],
    ["keeps a very long value intact", "x".repeat(500), "x".repeat(500)],
    ["keeps a unicode value", "café", "café"],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(normalizeSettingValue(input)).toBe(expected);
  });
});

describe("normalizeTimeFormat", () => {
  const cases: Array<[string, string | null, "12" | "24" | null]> = [
    ["returns '12' for '12'", "12", "12"],
    ["returns '24' for '24'", "24", "24"],
    ["trims before matching", "  24  ", "24"],
    ["returns null for an unknown format", "48", null],
    ["returns null for the empty string", "", null],
    ["returns null for null", null, null],
    ["returns null for the literal 'null'", "null", null],
    ["returns null for a partial match", "124", null],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(normalizeTimeFormat(input)).toBe(expected);
  });
});

describe("parseBooleanSetting", () => {
  const cases: Array<[string, string | null, boolean | null]> = [
    ["parses '1' as true", "1", true],
    ["parses 'true' as true", "true", true],
    ["parses 'TRUE' as true (case-insensitive)", "TRUE", true],
    ["parses '  true  ' as true after trim", "  true  ", true],
    ["parses '0' as false", "0", false],
    ["parses 'false' as false", "false", false],
    ["parses 'False' as false (case-insensitive)", "False", false],
    ["returns null for an unrecognized token", "yes", null],
    ["returns null for the empty string", "", null],
    ["returns null for null", null, null],
    ["returns null for the literal 'null'", "null", null],
    ["returns null for '2'", "2", null],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(parseBooleanSetting(input)).toBe(expected);
  });
});

describe("parseLocaleList", () => {
  const cases: Array<[string, string | null, string | null]> = [
    ["returns the only locale", "en-US", "en-US"],
    ["returns the first of a comma list", "en-US,fr-FR,de-DE", "en-US"],
    ["trims the primary locale", " en-US , fr-FR ", "en-US"],
    ["returns null for an empty list", "", null],
    ["returns null for null", null, null],
    ["returns null for the literal 'null'", "null", null],
    ["returns null when the first entry is empty", ",fr-FR", null],
    ["returns the primary even with trailing comma", "en-US,", "en-US"],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(parseLocaleList(input)).toBe(expected);
  });
});

describe("extractCalendarFromLocale", () => {
  const cases: Array<[string, string, string | null]> = [
    ["reads the @calendar= keyword form", "th-TH@calendar=buddhist", "buddhist"],
    ["reads @calendar= case-insensitively", "th-TH@CALENDAR=buddhist", "buddhist"],
    ["reads the BCP-47 -u-ca- extension", "en-US-u-ca-gregory", "gregory"],
    ["reads -u-ca- from an underscore locale", "en_US_u_ca_japanese", "japanese"],
    ["joins a multi-segment calendar type", "en-US-u-ca-islamic-civil", "islamic-civil"],
    [
      "prefers the keyword form over the extension",
      "en-US-u-ca-gregory@calendar=buddhist",
      "buddhist",
    ],
    ["reads -u-ca- when another key precedes it", "en-US-u-nu-latn-ca-persian", "persian"],
    ["returns null when there is no calendar", "en-US", null],
    ["returns null for a -u- extension without ca", "en-US-u-nu-latn", null],
    ["returns null for the empty string", "", null],
    ["returns null for whitespace only", "   ", null],
    ["trims surrounding whitespace before parsing", "  en-US-u-ca-gregory  ", "gregory"],
  ];
  it.each(cases)("%s", (_name, input, expected) => {
    expect(extractCalendarFromLocale(input)).toBe(expected);
  });
});
