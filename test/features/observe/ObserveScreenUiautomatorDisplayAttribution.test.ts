import { afterEach, beforeEach, expect, test } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import type { BootedDevice, HierarchySource } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { createFlatHierarchyForTest } from "./flatHierarchyBuilders";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel 7", platform: "android" };

beforeEach(() => displayTransitions.reset(device.deviceId));
afterEach(() => {
  displayTransitions.reset(device.deviceId);
  resetObserveCacheStore();
});

const launcher = {
  appId: "com.google.android.apps.nexuslauncher",
  activityName: "com.google.android.apps.nexuslauncher.NexusLauncherActivity",
};

/** The legacy window query answers for the default display (the launcher unless overridden). */
async function observe(
  sources: HierarchySource[],
  defaultDisplayWindow: { appId: string; activityName: string } = launcher,
) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_700_000_000_000);
  const viewHierarchy = new FakeViewHierarchy();
  viewHierarchy.configureHierarchy(
    createFlatHierarchyForTest({
      fresh: false,
      sources,
      screenWidth: 1080,
      screenHeight: 720,
      packageName: "com.android.settings",
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 720 },
          node: [{ text: "Settings", bounds: { left: 0, top: 100, right: 200, bottom: 160 } }],
        },
      },
    }),
  );
  const screen = new RealObserveScreen(
    device,
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    {
      viewHierarchy,
      window: {
        getActive: async () => ({ ...defaultDisplayWindow, layoutSeqSum: 7 }),
        getActiveHash: async () => "hash",
        getCachedActiveWindow: async () => null,
        setCachedActiveWindow: async () => undefined,
        clearCache: async () => undefined,
      },
      cacheStore: new FakeObserveCacheStore(new FakeTimer()),
      performanceAuditor: { run: async () => undefined },
      accessibilityAuditor: { run: async () => undefined },
      accessibilityStateDetector: { run: async () => undefined },
    },
    { timer },
  );
  return screen.execute({ skipScreenshot: true, skipBackStack: true });
}

test("a UIAutomator-only display read replaces the default display's app attribution", async () => {
  const result = await observe(["uiautomator"]);
  expect(result.activeWindow?.appId).toBe("com.android.settings");
  expect(result.activeWindow?.activityName).toBe("");
  expect(result.activeWindow?.layoutSeqSum).toBe(7);
});

test("a UIAutomator-only display read drops the default display's activity of the same app", async () => {
  const result = await observe(["uiautomator"], {
    appId: "com.android.settings",
    activityName: "com.android.settings.SubSettings",
  });
  expect(result.activeWindow?.appId).toBe("com.android.settings");
  expect(result.activeWindow?.activityName).toBe("");
  expect(result.activeWindow?.layoutSeqSum).toBe(7);
});

test("a CtrlProxy read keeps the window query's attribution", async () => {
  const result = await observe(["control-proxy"]);
  expect(result.activeWindow?.appId).toBe("com.google.android.apps.nexuslauncher");
});
