import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { OpenURL } from "../../../src/features/action/OpenURL";
import { PressButton } from "../../../src/features/action/PressButton";
import { RecentApps } from "../../../src/features/action/RecentApps";
import { HomeScreen } from "../../../src/features/action/HomeScreen";
import { RestoreSnapshot } from "../../../src/features/action/RestoreSnapshot";
import { DefaultDeviceWindowCacheInvalidator } from "../../../src/features/observe/DeviceWindowCacheInvalidator";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import {
  resetObserveCacheStore,
  setObserveCacheStore,
  pendingWindowResolutionGeneration,
  completeWindowResolutionRead,
} from "../../../src/features/observe/cache/ObserveCacheRegistry";
import type { ObserveResult } from "../../../src/models";
import { FakeDeviceWindowCacheInvalidator } from "../../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeTimer } from "../../fakes/FakeTimer";

const device = { name: "foreground", deviceId: "foreground", platform: "android" } as const;
const observation: ObserveResult = {
  screenSize: { width: 1080, height: 2400 },
  systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
  viewHierarchy: { hierarchy: {} },
  freshness: { isFresh: true },
  settled: true,
};

afterEach(() => resetObserveCacheStore());

function wire(action: BaseVisualChange) {
  const observe = new FakeObserveScreen();
  observe.setObserveResult(observation);
  action.observeScreen = observe;
  action.awaitIdle = new FakeAwaitIdle();
  const window = new FakeWindow();
  window.configureActiveWindow({
    appId: "com.android.launcher",
    activityName: "Launcher",
    layoutSeqSum: 0,
  });
  action.window = window;
  const invalidator = new FakeDeviceWindowCacheInvalidator();
  action.windowCacheInvalidator = invalidator;
  return invalidator;
}

describe("shared foreground cache invalidation", () => {
  test("clears only the selected device and fences late observation writes", async () => {
    const timer = new FakeTimer();
    const cache = new FakeObserveCacheStore(timer);
    setObserveCacheStore(cache);
    await cache.put(device.deviceId, observation);
    await cache.put("other-device", observation);
    const generation = cache.currentGeneration(device.deviceId);
    let invalidations = 0;
    const existing = spyOn(AndroidCtrlProxyClient, "getExistingInstance").mockReturnValue({
      invalidateCache: () => {
        invalidations++;
      },
    } as unknown as AndroidCtrlProxyClient);
    try {
      new DefaultDeviceWindowCacheInvalidator().invalidate(device, true);
      expect(invalidations).toBe(1);
      expect(await cache.getMostRecent(device.deviceId)).toBeUndefined();
      await cache.put(device.deviceId, observation, generation);
      expect(await cache.getMostRecent(device.deviceId)).toBeUndefined();
      expect(await cache.getMostRecent("other-device")).toBe(observation);
      const pending = pendingWindowResolutionGeneration(device.deviceId);
      expect(pending).toBe(cache.currentGeneration(device.deviceId));
      await cache.put(device.deviceId, observation); // a post-action transition frame
      expect(pendingWindowResolutionGeneration(device.deviceId)).toBe(pending);
      expect(pendingWindowResolutionGeneration("other-device")).toBeUndefined();
      new DefaultDeviceWindowCacheInvalidator().invalidate(device, true);
      completeWindowResolutionRead(device.deviceId, pending!);
      expect(pendingWindowResolutionGeneration(device.deviceId)).toBe(pending! + 1);
    } finally {
      existing.mockRestore();
    }
  });

  test.each(["home", "back", "recent"])(
    "pressButton %s invalidates through its shared low-level dispatch",
    async (button) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const action = new PressButton(device, new FakeAdbExecutor(), timer);
      const invalidator = wire(action);
      await action.press(button, 100);
      expect(invalidator.calls).toEqual([device]);
    },
  );

  test("in-place volume button does not invalidate", async () => {
    const action = new PressButton(device, new FakeAdbExecutor());
    const invalidator = wire(action);
    await action.press("volume_up");
    expect(invalidator.calls).toEqual([]);
  });

  test.each(["openLink", "recentApps", "homeScreen"])(
    "%s invalidates before its post-action capture",
    async (name) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const adb = new FakeAdbExecutor();
      const action =
        name === "openLink"
          ? new OpenURL(device, adb, null, null, timer)
          : name === "recentApps"
            ? new RecentApps(device, adb, timer)
            : new HomeScreen(device, adb, timer);
      const invalidator = wire(action);
      const execute = action.observeScreen.execute.bind(action.observeScreen);
      action.observeScreen.execute = async (options) => {
        if (name === "homeScreen" && options?.skipCache) {
          // Home's cache revalidation happens before dispatch, without caching this read.
          expect(invalidator.calls).toEqual([]);
          expect(options.freshness).toBe("fresh");
        } else {
          expect(invalidator.calls).toEqual([device]);
        }
        return execute(options);
      };
      if (action instanceof OpenURL) {
        await action.execute("https://example.test");
      } else {
        await action.execute();
      }
      expect(invalidator.calls).toEqual([device]);
    },
  );

  test("snapshot foreground restoration invalidates even after an uncertain dispatch", async () => {
    const action = new RestoreSnapshot(device, new FakeAdbClientFactory(new FakeAdbExecutor()));
    const invalidator = new FakeDeviceWindowCacheInvalidator();
    action.windowCacheInvalidator = invalidator;
    await action["restoreForegroundApp"]("com.example.new");
    expect(invalidator.calls).toEqual([device]);
  });

  test("shared action seam invalidates a partially failed app-changing dispatch", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const action = new BaseVisualChange(device, new FakeAdbExecutor(), timer);
    const invalidator = wire(action);
    await expect(
      action.observedInteraction(
        async () => {
          throw new Error("uncertain dispatch");
        },
        {
          changeExpected: false,
          foregroundAppMayChange: true,
        },
      ),
    ).rejects.toThrow("uncertain dispatch");
    expect(invalidator.calls).toEqual([device]);
  });
});
