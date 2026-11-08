import { describe, expect, test } from "bun:test";
import {
  IME_PARTIAL_COMMIT_NEXT_STEP,
  imePartialCommitGuidance,
  isFormattedNumericInput,
  reformattedDigitsPreserved,
} from "../../../src/features/action/imePartialCommitGuidance";

describe("imePartialCommitGuidance (#17462)", () => {
  test("names dropped digits and the a11y replace next step for the dogfood phone field", () => {
    expect(
      imePartialCommitGuidance("5125550142", {
        insertedText: " 512-555",
        deviceReportedSuccess: true,
      }),
    ).toBe(
      "The device reported the commit complete, but the editor's read-back does not match. " +
        "The field appears to reformat input as you type and kept 6 of 10 digits. " +
        'Retry with operation: "replace", mode: "a11y" to set the whole value at once, ' +
        "or type the missing digits in a separate command.",
    );
  });

  test("gives no digit count from a whole-field read-back", () => {
    expect(imePartialCommitGuidance("5125550142", {})).not.toContain("kept");
  });

  test("falls back to the generic next step for non-numeric or password text", () => {
    expect(imePartialCommitGuidance("hello", { insertedText: "hel" })).toBe(
      IME_PARTIAL_COMMIT_NEXT_STEP,
    );
    expect(imePartialCommitGuidance("1234", { insertedText: "12", passwordField: true })).toBe(
      IME_PARTIAL_COMMIT_NEXT_STEP,
    );
  });

  test.each([
    ["5125550142", true],
    ["+1 512-555-0142", true],
    ["2026-11-08", true],
    ["abc123", false],
    ["--", false],
  ])("isFormattedNumericInput(%p) is %p", (text, expected) => {
    expect(isFormattedNumericInput(text)).toBe(expected);
  });

  test.each([
    ["+1 512-555-0142", "5125550142", true],
    ["(512) 555-0142", "5125550142", true],
    ["+1 512-555", "5125550142", false],
    ["512-555-0142", "hello", false],
  ])("reformattedDigitsPreserved(%p, %p) is %p", (field, sent, expected) => {
    expect(reformattedDigitsPreserved(field, sent)).toBe(expected);
  });
});
