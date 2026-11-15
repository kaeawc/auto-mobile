import { expect, test } from "bun:test";
import { LaunchObservation } from "../../../src/features/action/LaunchObservation";
import { buildLaunchAppResponse } from "../../../src/server/appTools";
import type {
  BackStackInfo,
  BootedDevice,
  LaunchAppResult,
  ObserveResult,
} from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeDeviceWindowCacheInvalidator } from "../../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { buildObserveResult } from "../../helpers/observeFixture";

const contacts = "com.google.android.contacts";
const settings = "com.android.settings";
const device: BootedDevice = { platform: "android", deviceId: "emulator-5554", name: "pixel" };

function setup() {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const observeScreen = new FakeObserveScreen();
  const launchObservation = new LaunchObservation({
    device,
    adb: new FakeAdbExecutor(),
    timer,
    observeScreen,
    cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
  });
  return { timer, observeScreen, launchObservation };
}

function observation(appId: string, backStack: BackStackInfo): ObserveResult {
  return buildObserveResult({
    updatedAt: 0,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { hierarchy: { node: {} }, packageName: appId },
    activeWindow: { appId, activityName: "MainActivity", layoutSeqSum: 1 },
    backStack,
  });
}

// `am start` has made the Contacts task current, but the Settings window is still drawn.
const coldStartBackStack: BackStackInfo = {
  depth: 1,
  activities: [],
  currentTaskId: 20,
  tasks: [
    { id: 20, userId: 0, packageName: contacts, rootActivity: `${contacts}/.PeopleActivity` },
    { id: 12, userId: 0, packageName: settings, rootActivity: `${settings}/.Settings` },
  ],
};
const previousAppStillDrawn = observation(settings, coldStartBackStack);
const contactsDrawn = observation(contacts, coldStartBackStack);

test("a cold start keeps polling past the previous app's window until the target draws", async () => {
  const { timer, observeScreen, launchObservation } = setup();
  let polls = 0;
  observeScreen.setObserveResult(() => (++polls >= 3 ? contactsDrawn : previousAppStillDrawn));
  const launched: LaunchAppResult = {
    success: true,
    packageName: contacts,
    observation: previousAppStillDrawn,
  };

  const result = await launchObservation.ensureLaunchObservationMatchesPackage(launched, contacts, {
    timeoutMs: 5000,
    pollIntervalMs: 200,
    expectedUserId: 0,
  });

  expect(result.success).toBe(true);
  expect(result.verifiedBy).toBeUndefined();
  expect(result.observation?.activeWindow?.appId).toBe(contacts);
  expect(timer.getSleepHistory()).toEqual([200, 200, 200]);
  const response = buildLaunchAppResponse(contacts, result);
  expect(response.verified).toBe(true);
  expect(response.observedAppId).toBe(contacts);
});

test("a cold start that never draws fails with the previous app's observation omitted", async () => {
  const { observeScreen, launchObservation } = setup();
  observeScreen.setObserveResult(previousAppStillDrawn);
  const launched: LaunchAppResult = {
    success: true,
    packageName: contacts,
    observation: previousAppStillDrawn,
  };

  const result = await launchObservation.ensureLaunchObservationMatchesPackage(launched, contacts, {
    timeoutMs: 1000,
    pollIntervalMs: 200,
    expectedUserId: 0,
  });

  expect(result.success).toBe(false);
  expect(result.verifiedBy).toBeUndefined();
  expect(result.observation).toBeUndefined();
  expect(result.observationOmitted).toEqual({
    reason: "stale_launch_observation",
    expectedPackage: contacts,
    reportedPackages: settings,
  });
  expect(result.error).toContain("did not reach the screen within 1000 ms");
  expect(result.error).toContain(`observe { waitFor: { activeWindow: { appId: "${contacts}" } } }`);
  expect(() => buildLaunchAppResponse(contacts, result)).toThrow("did not reach the screen");
});

test("a current task whose top activity is another package's does not verify by task root", async () => {
  const { observeScreen, launchObservation } = setup();
  const backStack: BackStackInfo = {
    depth: 1,
    activities: [],
    currentTaskId: 20,
    tasks: [
      {
        id: 20,
        userId: 0,
        packageName: contacts,
        rootActivity: `${contacts}/.PeopleActivity`,
        topActivity: `${contacts}/.PeopleActivity`,
      },
    ],
  };
  const stale = observation(settings, backStack);
  observeScreen.setObserveResult(stale);

  const result = await launchObservation.ensureLaunchObservationMatchesPackage(
    { success: true, packageName: contacts, observation: stale },
    contacts,
    { timeoutMs: 400, pollIntervalMs: 200, expectedUserId: 0 },
  );

  expect(result.success).toBe(false);
  expect(result.verifiedBy).toBeUndefined();
});

test("a helper activity on top of the target's own task still verifies at once", async () => {
  const { timer, observeScreen, launchObservation } = setup();
  const helper = "com.google.android.settings.intelligence";
  const backStack: BackStackInfo = {
    depth: 1,
    activities: [],
    currentTaskId: 8,
    tasks: [
      {
        id: 8,
        userId: 0,
        packageName: settings,
        rootActivity: `${settings}/.Settings`,
        topActivity: `${helper}/.SearchActivity`,
      },
      { id: 3, userId: 0, packageName: contacts, rootActivity: `${contacts}/.PeopleActivity` },
    ],
  };
  const helperObservation = observation(helper, backStack);

  const result = await launchObservation.ensureLaunchObservationMatchesPackage(
    { success: true, packageName: settings, observation: helperObservation },
    settings,
    { timeoutMs: 5000, pollIntervalMs: 200, expectedUserId: 0 },
  );

  expect(result.success).toBe(true);
  expect(result.verifiedBy).toBe("task-root");
  expect(timer.getSleepHistory()).toEqual([]);
  expect(observeScreen.getCallCount("execute")).toBe(0);
});
