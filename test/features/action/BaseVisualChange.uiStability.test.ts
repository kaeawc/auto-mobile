import { buildObserveResult } from "../../helpers/observeFixture";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { DEFAULT_GET_ACTIVE_TIMEOUT_MS } from "../../../src/features/observe/Window";
import { BootedDevice, ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

describe("BaseVisualChange UI stability platform guard", () => {
  let fakeAdb: FakeAdbExecutor;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeTimer: FakeTimer;
  let fakeWindow: FakeWindow;

  const packageName = "com.example.app";

  let observationIndex = 0;
  const createObserveResult = (): ObserveResult =>
    buildObserveResult({
      updatedAt: Date.now(),
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: { hierarchy: { node: { $: { text: String(++observationIndex) } } } },
    });

  function createVisualChange(platform: "android" | "ios"): BaseVisualChange {
    const device: BootedDevice = { name: "test-device", platform, deviceId: "device-123" };
    const instance = new BaseVisualChange(device, fakeAdb, fakeTimer, undefined, {
      awaitIdle: fakeAwaitIdle,
      observeScreen: fakeObserveScreen,
      window: fakeWindow,
    });
    return instance;
  }

  beforeEach(() => {
    // A pending window resolution is keyed by the module-level cache store and device id; one an
    // earlier file left for "device-123" forces a fresh read that this fixture cannot satisfy.
    resetObserveCacheStore();
    fakeAdb = new FakeAdbExecutor();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeObserveScreen = new FakeObserveScreen();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    fakeWindow = new FakeWindow();

    fakeObserveScreen.setObserveResult(createObserveResult());
    fakeWindow.configureCachedActiveWindow({
      appId: packageName,
      activityName: "Main",
      layoutSeqSum: 1,
    });
  });

  afterEach(() => {
    resetObserveCacheStore();
  });

  test("runs gfxinfo UI stability tracking on Android", async () => {
    const instance = createVisualChange("android");
    const controller = new AbortController();

    await instance.observedInteraction(async () => ({ success: true }), {
      changeExpected: false,
      signal: controller.signal,
    });

    expect(fakeAwaitIdle.wasMethodCalled("initializeUiStabilityTracking")).toBe(true);
    expect(fakeAwaitIdle.getInitializeSignal()).toBe(controller.signal);
  });

  test.each([true, false])(
    "changed cached window=%s selects the destination only after dispatch",
    async (changed) => {
      const instance = createVisualChange("android");
      const previous = createObserveResult();
      previous.viewHierarchy!.packageName = "com.android.settings";
      fakeObserveScreen.setObserveResult(previous);
      const destination = "com.example.destination";
      await instance.observedInteraction(
        async () => {
          if (changed) {
            fakeWindow.configureCachedActiveWindow({
              appId: destination,
              activityName: "Destination",
              layoutSeqSum: 2,
            });
          }
          return { success: true };
        },
        { changeExpected: false, packageName: "com.android.settings" },
      );
      const expected = changed ? destination : "com.android.settings";
      expect(fakeAwaitIdle.getExecutedOperations()).toContain(
        `initializeUiStabilityTracking(${expected}, 12000)`,
      );
      expect(fakeAwaitIdle.getExecutedOperations()).toContain(
        `waitForUiStabilityWithState(${expected}, 12000)`,
      );
      expect(fakeWindow.getGetActiveCallCount()).toBe(0);
    },
  );

  // The block only fires an intent (Android OpenURL): it never refreshes this Window, so the
  // post-dispatch cache still holds the pre-action window while the device shows the destination.
  const destinationWindow = {
    appId: "com.example.destination",
    activityName: "Main",
    layoutSeqSum: 7,
  };

  async function openUrlLike(instance: BaseVisualChange, signal?: AbortSignal): Promise<void> {
    const previous = createObserveResult();
    previous.viewHierarchy!.packageName = "com.android.settings";
    fakeObserveScreen.setObserveResult(previous);
    await instance.observedInteraction(
      async () => {
        expect(fakeWindow.getGetActiveCallCount()).toBe(0);
        return { success: true };
      },
      { changeExpected: false, foregroundAppMayChange: true, signal },
    );
  }

  test("a foreground change the block did not cache targets the device's destination (#14447)", async () => {
    fakeWindow.configureActiveWindow(destinationWindow);
    const controller = new AbortController();

    await openUrlLike(createVisualChange("android"), controller.signal);

    expect(fakeAwaitIdle.getExecutedOperations()).toContain(
      "waitForUiStabilityWithState(com.example.destination, 12000)",
    );
    expect(fakeWindow.getGetActiveForceRefreshes()).toEqual([true]);
    expect(fakeWindow.getGetActiveOptions()).toEqual([
      { timeoutMs: DEFAULT_GET_ACTIVE_TIMEOUT_MS, signal: controller.signal },
    ]);
  });

  test("a failed post-dispatch window read falls back to the pre-action package", async () => {
    // No device window configured: FakeWindow.getActive rejects like a wedged dumpsys.
    await openUrlLike(createVisualChange("android"));

    expect(fakeWindow.getGetActiveCallCount()).toBe(1);
    expect(fakeAwaitIdle.getExecutedOperations()).toContain(
      "waitForUiStabilityWithState(com.android.settings, 12000)",
    );
  });

  test("an explicit destination package skips the fresh window read", async () => {
    fakeWindow.configureActiveWindow(destinationWindow);

    await createVisualChange("android").observedInteraction(async () => ({ success: true }), {
      changeExpected: false,
      foregroundAppMayChange: true,
      packageName: "com.example.launched",
    });

    expect(fakeWindow.getGetActiveCallCount()).toBe(0);
    expect(fakeAwaitIdle.getExecutedOperations()).toContain(
      "waitForUiStabilityWithState(com.example.launched, 12000)",
    );
  });

  test("the default gfxinfo stability wait polls on the injected timer, not the wall clock", async () => {
    const device: BootedDevice = {
      name: "test-device",
      platform: "android",
      deviceId: "device-123",
    };
    const instance = new BaseVisualChange(device, fakeAdb, fakeTimer);
    instance.observeScreen = fakeObserveScreen;
    instance.window.getCachedActiveWindow = fakeWindow.getCachedActiveWindow.bind(fakeWindow);

    await instance.observedInteraction(async () => ({ success: true }), { changeExpected: false });

    // AwaitIdle's 17ms gfxinfo poll ran on the real clock before it shared this timer.
    expect(fakeTimer.wasSleepCalled(17)).toBe(true);
  });

  test("preserves explicit success:false when changeExpected is true", async () => {
    const instance = createVisualChange("ios");

    // Set up a factory so each observe call returns a distinct object
    fakeObserveScreen.setObserveResult(() => createObserveResult());

    const result = await instance.observedInteraction(
      async () => ({ success: false, error: "Set text timed out after 5000ms" }),
      { changeExpected: true },
    );

    // The inner block explicitly failed — observedInteraction must NOT override to success
    expect(result.success).toBe(false);
    expect(result.error).toBe("Set text timed out after 5000ms");
  });

  test("applies visual change check when inner block succeeds with changeExpected", async () => {
    const instance = createVisualChange("ios");

    // Factory returns distinct objects — visual change detected via reference inequality
    fakeObserveScreen.setObserveResult(() => createObserveResult());

    const result = await instance.observedInteraction(async () => ({ success: true }), {
      changeExpected: true,
    });

    // Inner block succeeded and each capture contains changed text → success: true
    expect(result.success).toBe(true);
  });

  test("skips gfxinfo UI stability tracking on iOS", async () => {
    const instance = createVisualChange("ios");

    await instance.observedInteraction(async () => ({ success: true }), { changeExpected: false });

    expect(fakeAwaitIdle.wasMethodCalled("initializeUiStabilityTracking")).toBe(false);
    expect(fakeAwaitIdle.getWaitForUiStabilityCallCount()).toBe(0);
    expect(fakeAwaitIdle.getWaitForUiStabilityWithStateCallCount()).toBe(0);
  });
});
