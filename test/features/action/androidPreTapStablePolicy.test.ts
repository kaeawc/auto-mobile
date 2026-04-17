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

  test("plain text tap uses one consecutive match (re-find still required)", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        text: "Jane Smith",
        action: "tap"
      })
    ).toBe(1);
  });

  test("text plus elementId uses one consecutive match", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        text: "OK",
        elementId: "com.app:id/confirm",
        action: "tap"
      })
    ).toBe(1);
  });

  test("tapClickableParent keeps strict matches (list rows with dynamic content)", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        text: "Row",
        tapClickableParent: true,
        action: "tap"
      })
    ).toBe(ANDROID_PRE_TAP_STABLE_MATCHES_STRICT);
  });

  test("siblingOfText and clickable paths stay strict", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        siblingOfText: "Label",
        action: "tap"
      })
    ).toBe(ANDROID_PRE_TAP_STABLE_MATCHES_STRICT);
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        clickable: true,
        action: "tap"
      })
    ).toBe(ANDROID_PRE_TAP_STABLE_MATCHES_STRICT);
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        clickable: true,
        scrollableContainer: true,
        action: "tap"
      })
    ).toBe(ANDROID_PRE_TAP_STABLE_MATCHES_STRICT);
  });
});
