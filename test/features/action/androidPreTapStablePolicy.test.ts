import { describe, expect, test } from "bun:test";
import {
  ANDROID_PRE_TAP_STABLE_MATCHES_STRICT,
  androidPreTapConsecutiveStableMatchesRequired,
} from "../../../src/features/action/androidPreTapStablePolicy";

describe("androidPreTapConsecutiveStableMatchesRequired", () => {
  test("elementId-only tap uses one consecutive match", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        elementId: "com.app:id/avatarButton",
        action: "tap",
      }),
    ).toBe(1);
  });

  test("plain text tap uses one consecutive match", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        text: "Jane Smith",
        action: "tap",
      }),
    ).toBe(1);
  });

  test("sibling tap uses strict matches (tapping adjacent element is churn-prone)", () => {
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

  test("sibling: false uses one match", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        text: "Login",
        sibling: false,
        action: "tap",
      }),
    ).toBe(1);
  });

  // Full specification. Only a strict boolean `true` takes the strict path (2);
  // every other value — including untyped MCP coercions like the number 1 or the
  // string "true" — takes the lax single-match path (1). This pins that a loosely
  // typed sibling flag can never silently loosen churn tolerance.
  test.each<[string, unknown, number]>([
    ["boolean true", true, ANDROID_PRE_TAP_STABLE_MATCHES_STRICT],
    ["boolean false", false, 1],
    ["undefined", undefined, 1],
    ["number 1", 1, 1],
    ["number 0", 0, 1],
    ["string 'true'", "true", 1],
    ["string 'false'", "false", 1],
    ["null", null, 1],
    ["empty string", "", 1],
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
