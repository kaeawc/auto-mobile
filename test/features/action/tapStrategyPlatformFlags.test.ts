import { describe, expect, test } from "bun:test";
import { AndroidTapStrategy } from "../../../src/features/action/strategies/AndroidTapStrategy";
import { IosTapStrategy } from "../../../src/features/action/strategies/IosTapStrategy";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";

const flags = (s: AndroidTapStrategy | IosTapStrategy | FakeTapStrategy) => ({
  warnsOnDisabledTarget: s.warnsOnDisabledTarget,
  settlesFocusChangeAfterTap: s.settlesFocusChangeAfterTap,
  checksRefreshedDisplay: s.checksRefreshedDisplay,
  promotesTapTargetToAncestor: s.promotesTapTargetToAncestor,
});

const android = {
  warnsOnDisabledTarget: true,
  settlesFocusChangeAfterTap: false,
  checksRefreshedDisplay: true,
  promotesTapTargetToAncestor: true,
};
const ios = {
  warnsOnDisabledTarget: false,
  settlesFocusChangeAfterTap: true,
  checksRefreshedDisplay: false,
  promotesTapTargetToAncestor: false,
};

describe("TapStrategy platform flags", () => {
  test("Android strategy keeps the Android-only tap behaviours", () => {
    const device = { name: "d", platform: "android", deviceId: "e" } as const;
    expect(flags(new AndroidTapStrategy(device, new FakeAdbExecutor()))).toEqual(android);
    expect(flags(new FakeTapStrategy("android"))).toEqual(android);
  });

  test("iOS strategy keeps the iOS-only tap behaviours", () => {
    const device = { name: "d", platform: "ios", deviceId: "u" } as const;
    expect(flags(new IosTapStrategy(device))).toEqual(ios);
    expect(flags(new FakeTapStrategy("ios"))).toEqual(ios);
  });
});
