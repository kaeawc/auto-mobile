import { describe, expect, it } from "bun:test";
import {
  localeTagsEquivalent,
  validateLocaleTag,
} from "../../../src/features/utility/system-configuration/parsing";

describe("validateLocaleTag (#10155)", () => {
  for (const tag of [
    "fr-FR",
    "sr-Latn-RS",
    "zh-Hant-TW",
    "en-US",
    "en_US",
    "EN-us",
    "pt-BR",
    "fil",
    "yue-Hant-HK",
    "es-419",
    "en-u-ca-buddhist",
    // Real ISO 639-3 languages ICU 74 (Bun 1.3.14) has no English display name
    // for. Validation is structural only; the device judges whether it supports
    // the language and the read-back plus restore handles one it does not.
    "apc-SY",
    "lld-IT",
    "mhn-IT",
    "skr-PK",
    // Legacy ISO 639 spellings Android still reports as he/id/yi.
    "iw",
    "iw-IL",
    "in",
    "ji",
    // A well-formed tag whose language nobody has assigned is the device's call.
    "zz",
    // Regular grandfathered tag that Intl.Locale canonicalises (art-lojban -> jbo).
    "art-lojban",
  ]) {
    it(`accepts ${tag}`, () => {
      expect(validateLocaleTag(tag)).toBeNull();
    });
  }

  for (const [tag, reason] of [
    // The two tags from the issue's device repro.
    ["not_a_locale!!", "not a well-formed"],
    ["zz-ZZZZZZZZZ-123456789", "not a well-formed"],
    ["", "not a well-formed"],
    ["fr-FR,de-DE", "not a well-formed"],
    ["x-private", "not a well-formed"],
    ["en-", "not a well-formed"],
    ["und", "undetermined"],
    ["und-US", "undetermined"],
    ["qaa", "private-use language range"],
    ["qtz-QM", "private-use language range"],
    // Irregular grandfathered tags: Intl.Locale throws on them, so they are
    // refused as malformed rather than sent. Deliberate: they are deprecated
    // and every one has a modern replacement tag.
    ["i-klingon", "not a well-formed"],
    ["zh-min-nan", "not a well-formed"],
    ["en-GB-oed", "not a well-formed"],
  ] as const) {
    it(`rejects ${JSON.stringify(tag)}`, () => {
      expect(validateLocaleTag(tag)).toContain(reason);
    });
  }

  it("names the tag in every rejection", () => {
    for (const tag of ["i-klingon", "und", "qaa", "en-"]) {
      expect(validateLocaleTag(tag)).toContain(`"${tag}"`);
    }
  });
});

describe("localeTagsEquivalent (#10155)", () => {
  // [reported by the device, requested, equivalent]
  const pairs: ReadonlyArray<readonly [string | null, string, boolean]> = [
    ["fr-FR", "fr-FR", true],
    ["fr-fr", "fr-FR", true],
    ["fr_FR", "fr-FR", true],
    // Legacy language codes: Android reports the modern code.
    ["he", "iw", true],
    ["id", "in", true],
    ["yi", "ji", true],
    ["he-IL", "iw-IL", true],
    // Region defaulted by the device when the request named none.
    ["he-IL", "he", true],
    ["en-US", "en", true],
    // Script defaulted or spelled out.
    ["zh-Hant-TW", "zh-TW", true],
    ["zh-TW", "zh-Hant-TW", true],
    // The request named a region, so a different region is a real mismatch.
    ["fr-CA", "fr-FR", false],
    ["he-US", "he-IL", false],
    ["fr", "fr-CA", false],
    // A report that dropped the requested region is truncation, not a match.
    ["fr", "fr-FR", false],
    // Script mismatch.
    ["sr-RS", "sr-Latn-RS", false],
    ["sr-Latn-RS", "sr-RS", false],
    // Different language, and the und/truncated values from the issue.
    ["de", "fr", false],
    ["und", "fr-FR", false],
    // `und` must not be maximised into en-US and match a real English request.
    ["und", "en-US", false],
    ["und", "en", false],
    ["und-US", "en-US", false],
    ["zz", "zz-ZZ", false],
    // Extensions are part of the locale.
    ["en", "en-u-ca-buddhist", false],
    ["en-u-ca-buddhist", "en-u-ca-buddhist", true],
    // Unreadable or malformed reports never match.
    [null, "fr-FR", false],
    ["", "fr-FR", false],
    ["not a locale!", "fr-FR", false],
  ];
  for (const [actual, requested, expected] of pairs) {
    it(`reported ${JSON.stringify(actual)} vs requested ${JSON.stringify(requested)} -> ${expected}`, () => {
      expect(localeTagsEquivalent(actual, requested)).toBe(expected);
    });
  }
});
