import { describe, expect, test } from "bun:test";
import { DefaultTextMatcher, normalizeQuotes } from "../../../src/features/utility/TextMatcher";

describe("DefaultTextMatcher", () => {
  const matcher = new DefaultTextMatcher();

  describe("partialTextMatch", () => {
    test("returns false for empty first string", () => {
      expect(matcher.partialTextMatch("", "hello")).toBe(false);
    });

    test("returns false for empty second string", () => {
      expect(matcher.partialTextMatch("hello", "")).toBe(false);
    });

    test("returns false for both empty strings", () => {
      expect(matcher.partialTextMatch("", "")).toBe(false);
    });

    test("matches when first string contains second", () => {
      expect(matcher.partialTextMatch("hello world", "world")).toBe(true);
    });

    test("matches when second string contains first", () => {
      expect(matcher.partialTextMatch("world", "hello world")).toBe(true);
    });

    test("matches identical strings", () => {
      expect(matcher.partialTextMatch("hello", "hello")).toBe(true);
    });

    test("case insensitive by default", () => {
      expect(matcher.partialTextMatch("Hello", "hello")).toBe(true);
      expect(matcher.partialTextMatch("WORLD", "world")).toBe(true);
    });

    test("case sensitive when specified", () => {
      expect(matcher.partialTextMatch("Hello", "hello", true)).toBe(false);
      expect(matcher.partialTextMatch("Hello", "Hello", true)).toBe(true);
    });

    test("returns false for non-matching strings", () => {
      expect(matcher.partialTextMatch("abc", "xyz")).toBe(false);
    });
  });

  describe("createTextMatcher", () => {
    test("returns function that always returns false for empty search text", () => {
      const fn = matcher.createTextMatcher("");
      expect(fn("anything")).toBe(false);
      expect(fn("")).toBe(false);
      expect(fn(undefined)).toBe(false);
    });

    test("returned function returns false for undefined input", () => {
      const fn = matcher.createTextMatcher("search");
      expect(fn(undefined)).toBe(false);
    });

    test("returned function returns false for empty input", () => {
      const fn = matcher.createTextMatcher("search");
      expect(fn("")).toBe(false);
    });

    test("partial match (default) finds substring", () => {
      const fn = matcher.createTextMatcher("world");
      expect(fn("hello world")).toBe(true);
      expect(fn("worldly")).toBe(true);
      expect(fn("xyz")).toBe(false);
    });

    test("exact match rejects substring", () => {
      const fn = matcher.createTextMatcher("hello", false);
      expect(fn("hello")).toBe(true);
      expect(fn("hello world")).toBe(false);
    });

    test("case insensitive by default", () => {
      const fn = matcher.createTextMatcher("Hello");
      expect(fn("HELLO WORLD")).toBe(true);
      expect(fn("hello")).toBe(true);
    });

    test("case sensitive when specified", () => {
      const fn = matcher.createTextMatcher("Hello", true, true);
      expect(fn("Hello World")).toBe(true);
      expect(fn("hello world")).toBe(false);
    });

    test("exact match with case sensitivity", () => {
      const fn = matcher.createTextMatcher("Hello", false, true);
      expect(fn("Hello")).toBe(true);
      expect(fn("hello")).toBe(false);
      expect(fn("Hello World")).toBe(false);
    });
  });

  describe("Unicode quote normalization", () => {
    test("matches curly single quotes against straight apostrophe", () => {
      expect(matcher.partialTextMatch("Don't Allow", "Don\u2019t Allow")).toBe(true);
      expect(matcher.partialTextMatch("Don't Allow", "Don\u2018t Allow")).toBe(true);
    });

    test("matches curly double quotes against straight quotes", () => {
      expect(matcher.partialTextMatch('Allow "Reminders"', "Allow \u201CReminders\u201D")).toBe(
        true,
      );
    });

    test("matches em dash against hyphen", () => {
      expect(matcher.partialTextMatch("foo-bar", "foo\u2014bar")).toBe(true);
      expect(matcher.partialTextMatch("foo-bar", "foo\u2013bar")).toBe(true);
    });

    test("matches ellipsis against three dots", () => {
      expect(matcher.partialTextMatch("Loading...", "Loading\u2026")).toBe(true);
    });

    test("exact match normalizes quotes", () => {
      const fn = matcher.createTextMatcher("Don't Allow", false);
      expect(fn("Don\u2019t Allow")).toBe(true);
    });

    test("partial match normalizes quotes", () => {
      const fn = matcher.createTextMatcher("Don't", true);
      expect(fn("Don\u2019t Allow")).toBe(true);
    });

    test("case-sensitive match still normalizes quotes", () => {
      const fn = matcher.createTextMatcher("Don't Allow", false, true);
      expect(fn("Don\u2019t Allow")).toBe(true);
      expect(fn("don\u2019t allow")).toBe(false);
    });
  });

  describe("normalizeQuotes", () => {
    test("normalizes single quote variants", () => {
      expect(normalizeQuotes("\u2018hello\u2019")).toBe("'hello'");
      expect(normalizeQuotes("\u201Ahello\u201B")).toBe("'hello'");
      expect(normalizeQuotes("\u2032hello\u0060")).toBe("'hello'");
      expect(normalizeQuotes("\u00B4hello")).toBe("'hello");
    });

    test("normalizes double quote variants", () => {
      expect(normalizeQuotes("\u201Chello\u201D")).toBe('"hello"');
      expect(normalizeQuotes("\u201Ehello\u201F")).toBe('"hello"');
      expect(normalizeQuotes("\u00ABhello\u00BB")).toBe('"hello"');
      expect(normalizeQuotes("\u2033hello")).toBe('"hello');
    });

    test("normalizes dashes", () => {
      expect(normalizeQuotes("a\u2013b")).toBe("a-b"); // en dash
      expect(normalizeQuotes("a\u2014b")).toBe("a-b"); // em dash
      expect(normalizeQuotes("a\u2010b")).toBe("a-b"); // hyphen
    });

    test("normalizes ellipsis", () => {
      expect(normalizeQuotes("wait\u2026")).toBe("wait...");
    });

    test("leaves plain ASCII unchanged", () => {
      expect(normalizeQuotes("Don't Allow")).toBe("Don't Allow");
      expect(normalizeQuotes('"hello"')).toBe('"hello"');
    });

    test("does not normalize a non-breaking space (U+00A0 is outside the replacement set)", () => {
      // Boundary: NBSP is a common source of match failures in system dialogs but
      // is deliberately NOT in normalizeQuotes' replacement set. This pins that gap
      // so any future change to NBSP handling is a conscious, tested decision.
      expect(normalizeQuotes("a b")).toBe("a b");
    });
  });

  describe("non-breaking space boundary", () => {
    test("a regular space does not match a non-breaking space", () => {
      // Because NBSP is not normalized, "Allow App" and "Allow App" are not
      // considered equal — this is the observable consequence of the gap above.
      expect(matcher.partialTextMatch("Allow App", "Allow App")).toBe(false);
    });
  });
});
