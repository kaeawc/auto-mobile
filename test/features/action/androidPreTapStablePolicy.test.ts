import { describe, expect, test } from "bun:test";
import {
  ANDROID_PRE_TAP_STABLE_MATCHES_STRICT,
  androidPreTapConsecutiveStableMatchesRequired
} from "../../../src/features/action/androidPreTapStablePolicy";

describe("androidPreTapConsecutiveStableMatchesRequired", () => {
  test("elementId-only tap uses one consecutive match", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        elementId: "com.app:id/avatarButton",
        action: "tap"
      })
    ).toBe(1);
  });

  test("plain text tap uses one consecutive match", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        text: "Jane Smith",
        action: "tap"
      })
    ).toBe(1);
  });

  test("sibling tap uses strict matches (tapping adjacent element is churn-prone)", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        text: "Accept Terms",
        sibling: true,
        action: "tap"
      })
    ).toBe(ANDROID_PRE_TAP_STABLE_MATCHES_STRICT);
  });

  test("elementId + sibling uses strict matches", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        elementId: "com.app:id/label",
        sibling: true,
        action: "tap"
      })
    ).toBe(ANDROID_PRE_TAP_STABLE_MATCHES_STRICT);
  });

  test("sibling: false uses one match", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        text: "Login",
        sibling: false,
        action: "tap"
      })
    ).toBe(1);
  });
});
