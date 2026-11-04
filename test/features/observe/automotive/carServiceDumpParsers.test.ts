import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseDrivingState,
  parseUxRestrictions,
  parseDoActivities,
} from "../../../../src/features/observe/automotive/carServiceDumpParsers";

const capture = (name: string): string =>
  readFileSync(
    new URL(`../../../fixtures/automotive/aaos-34-userdebug/cap-${name}.txt`, import.meta.url),
    "utf8",
  );

describe("captured AAOS 34 car service output", () => {
  test("parked and moving driving states", () => {
    expect(parseDrivingState(capture("drivingstate-parked"))).toBe("parked");
    expect(parseDrivingState(capture("drivingstate-moving"))).toBe("moving");
    expect(parseDrivingState("Current Driving State: 1")).toBe("idling");
    expect(parseDrivingState("Current Driving State: 3")).toBeUndefined();
    expect(parseDrivingState("permission denied")).toBeUndefined();
  });
  test("selects the observed display, never the last display", () => {
    expect(parseUxRestrictions(capture("uxr-parked"), 0)).toEqual({
      requiresDistractionOptimization: false,
      activeRestrictions: 0,
    });
    expect(parseUxRestrictions(capture("uxr-moving"), 0)).toEqual({
      requiresDistractionOptimization: true,
      activeRestrictions: 255,
    });
    expect(parseUxRestrictions(capture("uxr-driving"), 0)).toEqual({
      requiresDistractionOptimization: true,
      activeRestrictions: 16,
    });
    expect(parseUxRestrictions(capture("uxr-parked"), 3)?.activeRestrictions).toBe(511);
    expect(parseUxRestrictions(capture("uxr-moving"), 9)).toBeUndefined();
    expect(parseUxRestrictions("", 0)).toBeUndefined();
  });
  test("DO list requires the matching header and preserves full class names", () => {
    const activities = parseDoActivities(
      capture("do-activities-car-settings"),
      "com.android.car.settings",
    );
    expect(
      activities?.has("com.android.car.settings.common.CarSettingActivities$HomepageActivity"),
    ).toBe(true);
    expect(activities?.has("com.android.car.settings.MissingActivity")).toBe(false);
    expect(
      parseDoActivities(capture("do-activities-android-settings"), "com.android.settings"),
    ).toEqual(new Set());
    expect(
      parseDoActivities(capture("do-activities-car-settings"), "com.android.settings"),
    ).toBeUndefined();
    expect(parseDoActivities("permission denied", "com.android.settings")).toBeUndefined();
  });
});
