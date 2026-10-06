import { describe, expect, it } from "bun:test";
import { validateLocaleTag } from "../../../src/features/utility/system-configuration/parsing";

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
    ["zz", "not a recognised language"],
    ["qaa", "not a recognised language"],
    ["qtz-QM", "not a recognised language"],
  ] as const) {
    it(`rejects ${JSON.stringify(tag)}`, () => {
      expect(validateLocaleTag(tag)).toContain(reason);
    });
  }
});
