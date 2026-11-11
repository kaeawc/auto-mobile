import { expect, test } from "bun:test";
import { LaunchObservation } from "../../../src/features/action/LaunchObservation";
import {
  BLOCKED_BY_DRIVING_RESTRICTIONS,
  describeLaunchDrivingRestriction,
} from "../../../src/features/action/launchDrivingRestriction";
import { buildLaunchAppResponse } from "../../../src/server/appTools";
import type { BootedDevice, LaunchAppResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeDeviceWindowCacheInvalidator } from "../../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { readSettingsWhileDrivingObservation } from "../observe/automotive/drivingRestrictionBlockFixture";

const appId = "dev.dogfood.garage";
const device: BootedDevice = {
  platform: "android",
  deviceId: "emulator-5558",
  name: "aaos",
  formFactor: "automotive",
};

function setup() {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const observeScreen = new FakeObserveScreen();
  const launchObservation = new LaunchObservation({
    device,
    adb,
    timer,
    observeScreen,
    cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
  });
  return { adb, timer, observeScreen, launchObservation };
}

test("a launch the car's blocking activity covers fails at once naming the driving restriction", async () => {
  const { observeScreen, launchObservation, timer } = setup();
  const blocked = readSettingsWhileDrivingObservation();
  observeScreen.setObserveResult(blocked);
  const launched: LaunchAppResult = { success: true, packageName: appId, observation: blocked };

  const result = await launchObservation.ensureLaunchObservationMatchesPackage(launched, appId, {});

  expect(result.success).toBe(false);
  expect(result.error).toContain(BLOCKED_BY_DRIVING_RESTRICTIONS);
  expect(result.error).toContain("dev.dogfood.garage.SettingsActivity");
  expect(result.error).toContain("com.android.systemui.car.activity.ActivityBlockingActivity");
  expect(result.error).not.toContain("notification shade");
  expect(timer.getSleepHistory()).toEqual([]);
  expect(() => buildLaunchAppResponse(appId, result)).toThrow(BLOCKED_BY_DRIVING_RESTRICTIONS);
});

test("a block over another app's task is not reported as this launch's restriction", () => {
  const blocked = readSettingsWhileDrivingObservation();
  expect(describeLaunchDrivingRestriction(blocked, "com.example.other")).toBeUndefined();
  expect(describeLaunchDrivingRestriction(blocked, appId)).toContain(
    BLOCKED_BY_DRIVING_RESTRICTIONS,
  );
  expect(describeLaunchDrivingRestriction({}, appId)).toBeUndefined();
});

test("a block on another display over another app does not name this launch", () => {
  const blocked = readSettingsWhileDrivingObservation();
  const backStack = blocked.backStack;
  const [blocker, settings, carApp, ...rest] = backStack?.activities ?? [];
  expect(
    describeLaunchDrivingRestriction(
      {
        backStack: backStack && {
          ...backStack,
          activities: [settings, carApp, blocker, ...rest],
        },
      },
      appId,
    ),
  ).toBeUndefined();
});
