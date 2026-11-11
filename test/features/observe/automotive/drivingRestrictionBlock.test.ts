import { expect, test } from "bun:test";
import {
  ACTIVITY_BLOCKING_ACTIVITY,
  detectDrivingRestrictionBlock,
} from "../../../../src/features/observe/automotive/drivingRestrictionBlock";
import { readSettingsWhileDrivingObservation } from "./drivingRestrictionBlockFixture";

test("the captured blocking activity names itself and the activity it covers", () => {
  const { backStack } = readSettingsWhileDrivingObservation();
  expect(detectDrivingRestrictionBlock(backStack)).toEqual({
    blockedBy: ACTIVITY_BLOCKING_ACTIVITY,
    blockedActivity: "dev.dogfood.garage.SettingsActivity",
  });
});

test("a stack whose top is the app itself reports no block", () => {
  const { backStack } = readSettingsWhileDrivingObservation();
  const [, settings, ...rest] = backStack?.activities ?? [];
  expect(
    detectDrivingRestrictionBlock({ activities: [settings, ...rest], currentActivity: settings }),
  ).toBeUndefined();
  expect(detectDrivingRestrictionBlock(undefined)).toBeUndefined();
});

test("a blocking activity with no task under it still reports the blocker", () => {
  const { backStack } = readSettingsWhileDrivingObservation();
  const blocker = backStack?.activities[0];
  expect(
    detectDrivingRestrictionBlock({
      activities: blocker ? [blocker] : [],
      currentActivity: blocker,
    }),
  ).toEqual({ blockedBy: ACTIVITY_BLOCKING_ACTIVITY });
});

test("only activities listed after the blocker can be the one it covers", () => {
  const { backStack } = readSettingsWhileDrivingObservation();
  const [blocker, settings, ...rest] = backStack?.activities ?? [];
  // Another display's activities listed ahead of the blocker are not under it.
  expect(
    detectDrivingRestrictionBlock({
      activities: [...rest, blocker, settings],
      currentActivity: backStack?.currentActivity,
    }),
  ).toEqual({
    blockedBy: ACTIVITY_BLOCKING_ACTIVITY,
    blockedActivity: "dev.dogfood.garage.SettingsActivity",
  });
});
