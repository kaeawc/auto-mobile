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

  test("text selection keeps strict consecutive matches (Corkill-style lists)", () => {
    expect(
      androidPreTapConsecutiveStableMatchesRequired({
        text: "Dan Corkill",
        action: "tap"
      })
    ).toBe(ANDROID_PRE_TAP_STABLE_MATCHES_STRICT);
  });

  test("tapClickableParent keeps strict matches even with elementId unused", () => {
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
