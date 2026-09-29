import { describe, expect, test } from "bun:test";
import {
  ANDROID_PRE_TAP_STABLE_MATCHES_STRICT,
  androidPreTapConsecutiveStableMatchesRequired,
} from "../../../src/features/action/androidPreTapStablePolicy";

describe("androidPreTapConsecutiveStableMatchesRequired", () => {
  test("elementId-only tap uses strict consecutive matches", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        elementId: "com.app:id/avatarButton",
        action: "tap",
      }),
    ).toBe(ANDROID_PRE_TAP_STABLE_MATCHES_STRICT);
  });

  test("plain text tap uses strict consecutive matches", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        text: "Jane Smith",
        action: "tap",
      }),
    ).toBe(ANDROID_PRE_TAP_STABLE_MATCHES_STRICT);
  });

  test("sibling tap uses strict matches", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        text: "Accept Terms",
        sibling: true,
        action: "tap",
      }),
    ).toBe(ANDROID_PRE_TAP_STABLE_MATCHES_STRICT);
  });

  test("elementId + sibling uses strict matches", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        elementId: "com.app:id/label",
        sibling: true,
        action: "tap",
      }),
    ).toBe(ANDROID_PRE_TAP_STABLE_MATCHES_STRICT);
  });

  test("sibling: false uses strict matches", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        text: "Login",
        sibling: false,
        action: "tap",
      }),
    ).toBe(ANDROID_PRE_TAP_STABLE_MATCHES_STRICT);
  });

  // Every selector kind requires strict consecutive matches, regardless of the
  // sibling value or untyped MCP coercions.
  test.each<[string, unknown, number]>([
    ["boolean true", true, ANDROID_PRE_TAP_STABLE_MATCHES_STRICT],
    ["boolean false", false, ANDROID_PRE_TAP_STABLE_MATCHES_STRICT],
    ["undefined", undefined, ANDROID_PRE_TAP_STABLE_MATCHES_STRICT],
    ["number 1", 1, ANDROID_PRE_TAP_STABLE_MATCHES_STRICT],
    ["number 0", 0, ANDROID_PRE_TAP_STABLE_MATCHES_STRICT],
    ["string 'true'", "true", ANDROID_PRE_TAP_STABLE_MATCHES_STRICT],
    ["string 'false'", "false", ANDROID_PRE_TAP_STABLE_MATCHES_STRICT],
    ["null", null, ANDROID_PRE_TAP_STABLE_MATCHES_STRICT],
    ["empty string", "", ANDROID_PRE_TAP_STABLE_MATCHES_STRICT],
  ])("sibling=%s resolves to %i consecutive matches", (_name, sibling, expected) => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        text: "Accept Terms",
        sibling: sibling as boolean,
        action: "tap",
      }),
    ).toBe(expected);
  });
});
