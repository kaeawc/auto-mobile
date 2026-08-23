import { describe, expect, test } from "bun:test";
import { resolveAutoInputMode } from "../../../src/features/action/resolveAutoInputMode";

describe("resolveAutoInputMode", () => {
  test("returns undefined when no markers are configured (feature off)", () => {
    expect(resolveAutoInputMode("/msg @Nikki Kroll hi", [])).toBeUndefined();
  });

  test("promotes to eventAll when text contains a configured marker", () => {
    expect(resolveAutoInputMode("/msg @Nikki hi", ["@", "/", "#"])).toBe("eventAll");
  });

  test("matches any marker in the list, not just the first", () => {
    expect(resolveAutoInputMode("hello #channel", ["@", "/", "#"])).toBe("eventAll");
  });

  test("returns undefined when no marker is present in the text", () => {
    expect(resolveAutoInputMode("plain message", ["@", "/", "#"])).toBeUndefined();
  });

  test("matches multi-character markers via substring containment", () => {
    expect(resolveAutoInputMode("see https://x.test", ["https://"])).toBe("eventAll");
  });

  test("ignores empty-string markers", () => {
    expect(resolveAutoInputMode("plain", [""])).toBeUndefined();
  });

  test("supports the Slack formatting marker set", () => {
    for (const marker of ["@", "/", "#", ":", "_", "*", "~"]) {
      expect(resolveAutoInputMode(`a${marker}b`, ["@", "/", "#", ":", "_", "*", "~"])).toBe(
        "eventAll",
      );
    }
  });

  // Full specification table including boundary rows (empty, unicode, duplicate,
  // very long, whitespace). Unicode rows use the real composed characters "café"
  // and "é" — not pre-normalized NFD byte sequences, which are invisible in source
  // and flip on a single normalization.
  const longText = `${"x".repeat(5000)}@handle`;
  test.each<[string, string, readonly string[], "eventAll" | undefined]>([
    ["off with no markers", "/msg @x", [], undefined],
    ["matches a leading marker", "@handle hi", ["@"], "eventAll"],
    ["no marker present", "plain text", ["@", "/"], undefined],
    ["multi-character marker", "see https://x", ["https://"], "eventAll"],
    ["empty-string marker only", "anything", [""], undefined],
    ["empty text with real markers", "", ["@", "/"], undefined],
    ["empty text and empty marker", "", [""], undefined],
    ["unicode composed character matches", "café", ["é"], "eventAll"],
    ["unicode marker absent from ASCII text", "cafe", ["é"], undefined],
    ["marker equal to the entire text", "@", ["@"], "eventAll"],
    ["matches the second marker in the list", "hello #chan", ["@", "#"], "eventAll"],
    ["duplicate markers still match once", "a@b", ["@", "@"], "eventAll"],
    ["very long text with a trailing marker", longText, ["@"], "eventAll"],
    ["very long text without any marker", "y".repeat(5000), ["@"], undefined],
    ["whitespace marker present in text", "a b", [" "], "eventAll"],
    ["empty marker skipped but a later real marker matches", "a#b", ["", "#"], "eventAll"],
  ])("%s", (_name, text, markers, expected) => {
    expect(resolveAutoInputMode(text, markers)).toBe(expected);
  });
});
