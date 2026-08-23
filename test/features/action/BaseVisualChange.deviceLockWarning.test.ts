import { describe, expect, test, beforeEach } from "bun:test";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { BootedDevice, ObserveResult, DeviceLockState } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";

/**
 * Issue #4280: an interaction performed while the Android device is locked used
 * to return a clean `success: true`, so an agent counted a tap on the keyguard
 * as a real interaction with its app. observedInteraction now annotates the
 * result with the pre-action lock state and a secure-branched warning — without
 * blocking the gesture, so swipe-to-dismiss and PIN entry still work (the
 * approved "warn + annotate, still execute" behavior).
 */
describe("BaseVisualChange device-lock warning (#4280)", () => {
  let fakeAdb: FakeAdbExecutor;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeTimer: FakeTimer;
  let fakeWindow: FakeWindow;

  const observeWith = (deviceLock?: DeviceLockState): ObserveResult => ({
    updatedAt: 1,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { node: {} },
    ...(deviceLock ? { deviceLock } : {}),
  });

  function createVisualChange(platform: "android" | "ios"): BaseVisualChange {
    const device: BootedDevice = { name: "test-device", platform, deviceId: "device-123" };
    const instance = new BaseVisualChange(device, fakeAdb as unknown as any, fakeTimer);
    (instance as any).awaitIdle = fakeAwaitIdle;
    (instance as any).observeScreen = fakeObserveScreen;
    (instance as any).window = fakeWindow;
    return instance;
  }

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeObserveScreen = new FakeObserveScreen();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    fakeWindow = new FakeWindow();
    fakeWindow.configureCachedActiveWindow({
      appId: "com.example.app",
      activityName: "Main",
      layoutSeqSum: 1,
    });
  });

  test("secure lock: annotates deviceLock + a PIN-oriented warning, still succeeds", async () => {
    fakeObserveScreen.setObserveResult(
      observeWith({ locked: true, keyguardShowing: true, secure: true }),
    );
    const result = await createVisualChange("android").observedInteraction(
      async () => ({ success: true }),
      { changeExpected: false },
    );

    // The gesture still ran and reported success — recovery gestures are not blocked.
    expect(result.success).toBe(true);
    expect(result.deviceLock).toEqual({ locked: true, keyguardShowing: true, secure: true });
    expect(typeof result.deviceLockWarning).toBe("string");
    expect(result.deviceLockWarning.toLowerCase()).toContain("unlock");
  });

  test("swipe lock: warning points at dismissing the keyguard, not a PIN", async () => {
    fakeObserveScreen.setObserveResult(
      observeWith({ locked: true, keyguardShowing: true, secure: false }),
    );
    const result = await createVisualChange("android").observedInteraction(
      async () => ({ success: true }),
      { changeExpected: false },
    );

    expect(result.deviceLock).toEqual({ locked: true, keyguardShowing: true, secure: false });
    expect(result.deviceLockWarning.toLowerCase()).toContain("dismiss");
  });

  test("unlocked device: no deviceLock annotation", async () => {
    fakeObserveScreen.setObserveResult(
      observeWith({ locked: false, keyguardShowing: false, secure: true }),
    );
    const result = await createVisualChange("android").observedInteraction(
      async () => ({ success: true }),
      { changeExpected: false },
    );

    expect(result.deviceLock).toBeUndefined();
    expect(result.deviceLockWarning).toBeUndefined();
  });

  test("no deviceLock signal at all: no annotation", async () => {
    fakeObserveScreen.setObserveResult(observeWith());
    const result = await createVisualChange("android").observedInteraction(
      async () => ({ success: true }),
      { changeExpected: false },
    );

    expect(result.deviceLock).toBeUndefined();
    expect(result.deviceLockWarning).toBeUndefined();
  });

  test("iOS is never annotated even if a lock state is present", async () => {
    fakeObserveScreen.setObserveResult(() =>
      observeWith({ locked: true, keyguardShowing: true, secure: true }),
    );
    const result = await createVisualChange("ios").observedInteraction(
      async () => ({ success: true }),
      { changeExpected: false },
    );

    expect(result.deviceLock).toBeUndefined();
    expect(result.deviceLockWarning).toBeUndefined();
  });
});
