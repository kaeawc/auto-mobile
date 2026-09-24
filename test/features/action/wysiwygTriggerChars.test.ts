import { describe, expect, test } from "bun:test";
import { containsWysiwygTriggerChar } from "../../../src/features/action/wysiwygTriggerChars";

describe("containsWysiwygTriggerChar", () => {
  test("detects each formatting trigger", () => {
    for (const text of ["`", "*", "_", "~"]) {
      expect(containsWysiwygTriggerChar(text)).toBe(true);
    }
  });

  test("does not match plain or empty text", () => {
    expect(containsWysiwygTriggerChar("plain text")).toBe(false);
    expect(containsWysiwygTriggerChar("")).toBe(false);
  });
});
