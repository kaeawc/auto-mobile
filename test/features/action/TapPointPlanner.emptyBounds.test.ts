import { describe, expect, test } from "bun:test";
import { TapPointPlanner } from "../../../src/features/action/tapPointPlanner";
import {
  hasTapArea,
  TapTargetUnavailableError,
} from "../../../src/features/action/tapTargetSupport";
import type {
  ElementBounds,
  ElementSelectionResult,
  ScreenSize,
  ViewHierarchyResult,
} from "../../../src/models";
import { FakeElementGeometry } from "../../fakes/FakeElementGeometry";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";

const valid = { left: 10, top: 20, right: 30, bottom: 40 };
const invalid: ElementBounds[] = [
  { left: 0, top: 0, right: 0, bottom: 0 },
  { ...valid, right: valid.left },
  { ...valid, bottom: valid.top },
  { ...valid, right: valid.left - 1 },
  { ...valid, bottom: valid.top - 1 },
  ...(["left", "top", "right", "bottom"] as const).flatMap((edge) =>
    [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].map((value) => ({
      ...valid,
      [edge]: value,
    })),
  ),
];
const screens: Array<ScreenSize | undefined> = [
  undefined,
  { width: 0, height: 0 },
  { width: Number.NaN, height: 100 },
  { width: 100, height: Number.POSITIVE_INFINITY },
  { width: 100, height: 100 },
];
const hierarchy: ViewHierarchyResult = { hierarchy: {} };

function selection(bounds: ElementBounds): ElementSelectionResult {
  return { element: { bounds }, strategy: "unique", indexInMatches: 0, totalMatches: 1 };
}

for (const platform of ["ios", "android"] as const) {
  describe(`${platform} tap target area`, () => {
    const planner = new TapPointPlanner({
      device: { platform, deviceId: "fake", name: "Fake device" },
      geometry: () => new FakeElementGeometry(),
      strategy: () => new FakeTapStrategy(),
    });

    test.each(invalid)("refuses invalid target bounds %j regardless of screen size", (bounds) => {
      expect(hasTapArea(bounds)).toBe(false);
      for (const screenSize of screens) {
        const target = selection(bounds);
        expect(planner.isElementTapTargetOffScreen(target, hierarchy, screenSize)).toBe(true);
        expect(planner.visibleTapBounds(target, hierarchy, { screenSize })).toBeNull();
        const error = planner.invisibleMatchFailure(target, { action: "tap" }, hierarchy, {
          screenSize,
        });
        expect(error).toBeInstanceOf(TapTargetUnavailableError);
        expect(error.reason).toBe("no-visible-tap-area");
        expect(error.message).toContain("no visible tap area");
      }
    });

    test("keeps a finite target usable when screen size is unknown or unusable", () => {
      expect(hasTapArea(valid)).toBe(true);
      for (const screenSize of screens) {
        const target = selection(valid);
        expect(planner.isElementTapTargetOffScreen(target, hierarchy, screenSize)).toBe(false);
        expect(planner.visibleTapBounds(target, hierarchy, { screenSize })).toEqual(valid);
      }
    });

    test("rejects the target even when a matched label has valid bounds", () => {
      const target = { ...selection(invalid[0]), matchedElement: { bounds: valid } };
      expect(planner.isElementTapTargetOffScreen(target, hierarchy)).toBe(true);
      expect(planner.visibleTapBounds(target, hierarchy)).toBeNull();
    });

    test("invalid target geometry keeps the no-visible-tap-area reason ahead of navigation clipping", () => {
      const strategy = new FakeTapStrategy();
      strategy.clipNavigationTapBounds = () => ({ bounds: null, coveredBy: "navigation bar" });
      const clippedPlanner = new TapPointPlanner({
        device: { platform, deviceId: "fake", name: "Fake device" },
        geometry: () => new FakeElementGeometry(),
        strategy: () => strategy,
      });
      const target = {
        ...selection({ ...valid, right: Number.POSITIVE_INFINITY }),
        matchedElement: { bounds: valid },
      };
      expect(
        clippedPlanner.invisibleMatchFailure(target, { action: "tap" }, hierarchy).reason,
      ).toBe("no-visible-tap-area");
      expect(
        clippedPlanner.invisibleMatchFailure(selection(valid), { action: "tap" }, hierarchy).reason,
      ).toBe("navigation-bar");
    });
  });
}
