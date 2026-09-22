import { describe, expect, test } from "bun:test";
import {
  containsWysiwygTriggerChar,
  WYSIWYG_TRIGGER_CHARS,
} from "../../../src/features/action/wysiwygTriggerChars";

describe("containsWysiwygTriggerChar", () => {
  test("detects each WYSIWYG/markdown trigger character", () => {
    for (const char of WYSIWYG_TRIGGER_CHARS) {
      expect(containsWysiwygTriggerChar(`before${char}after`)).toBe(true);
    }
  });

  test("returns false for ordinary and empty text", () => {
    expect(containsWysiwygTriggerChar("hello world")).toBe(false);
    expect(containsWysiwygTriggerChar("")).toBe(false);
  });
});
