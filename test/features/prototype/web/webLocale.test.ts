import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../../src/models/ActionableError";
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
    expect(() => stillLocale("not a locale")).toThrow(ActionableError);
    expect(() => stillLocale("")).toThrow(ActionableError);
  });

  test("RTL languages and scripts lay out right to left", () => {
    for (const tag of ["ar", "ar-XB", "he-IL", "fa", "ur-PK", "az-Arab"]) {
      expect(localeLayoutDirection(tag)).toBe("rtl");
    }
    for (const tag of ["en-US", "en-XA", "fr", "sd-Deva", "zh-Hant-TW"]) {
      expect(localeLayoutDirection(tag)).toBe("ltr");
    }
  });
});
