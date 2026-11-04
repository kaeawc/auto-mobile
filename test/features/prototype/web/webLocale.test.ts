import { describe, expect, test } from "bun:test";
import { PrototypeWebInputError } from "../../../../src/features/prototype/web/prototypeWebInputError";
import {
  DEFAULT_STILL_LOCALE,
  localeLayoutDirection,
  stillLocale,
} from "../../../../src/features/prototype/web/webLocale";

describe("still locale (#16552)", () => {
  test("canonicalizes the tag and defaults to en-US", () => {
    expect(stillLocale(undefined)).toBe(DEFAULT_STILL_LOCALE);
    expect(stillLocale("EN-us")).toBe("en-US");
    expect(stillLocale("ar-XB")).toBe("ar-XB");
  });

  test("refuses a tag that is not BCP 47", () => {
    expect(() => stillLocale("not a locale")).toThrow(PrototypeWebInputError);
    expect(() => stillLocale("")).toThrow(PrototypeWebInputError);
  });

  test("RTL languages and scripts lay out right to left", () => {
    for (const tag of ["ar", "ar-XB", "he-IL", "fa", "ur-PK", "az-Arab", "ar-u-nu-latn"]) {
      expect(localeLayoutDirection(tag)).toBe("rtl");
    }
    // A Unicode extension's value is not a script subtag.
    for (const tag of ["en-US", "en-XA", "fr", "sd-Deva", "zh-Hant-TW", "en-u-nu-arab"]) {
      expect(localeLayoutDirection(tag)).toBe("ltr");
    }
  });
});
