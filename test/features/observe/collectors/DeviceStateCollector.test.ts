import { beforeEach, describe, expect, test } from "bun:test";
import { DeviceStateCollector } from "../../../../src/features/observe/collectors/DeviceStateCollector";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeWindow } from "../../../fakes/FakeWindow";
import { FakeTimer } from "../../../fakes/FakeTimer";
import type { BootedDevice, ObserveResult, BackStackInfo } from "../../../../src/models";
import type { BackStack } from "../../../../src/features/observe/interfaces/BackStack";

function makeResult(): ObserveResult {
  return {
    updatedAt: 0,
    screenSize: { width: 0, height: 0 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

function makeDevice(): BootedDevice {
  return {
    name: "test-device",
    platform: "android",
    deviceId: "test-device",
  } as BootedDevice;
}

class FakeBackStack implements BackStack {
  configured: BackStackInfo = {
    activities: [],
    tasks: [],
    currentActivity: null,
  } as unknown as BackStackInfo;
  shouldFail: Error | null = null;
  async execute(): Promise<BackStackInfo> {
    if (this.shouldFail) {
      throw this.shouldFail;
    }
    return this.configured;
  }
}

describe("DeviceStateCollector", () => {
  let fakeAdb: FakeAdbExecutor;
  let fakeBackStack: FakeBackStack;
  let fakeWindow: FakeWindow;
  let fakeTimer: FakeTimer;
  let collector: DeviceStateCollector;

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeBackStack = new FakeBackStack();
    fakeWindow = new FakeWindow();
    fakeTimer = new FakeTimer();
    collector = new DeviceStateCollector({
      device: makeDevice(),
      window: fakeWindow,
      backStack: fakeBackStack,
      adb: fakeAdb,
      timer: fakeTimer,
    });
  });

  describe("collectWakefulness", () => {
    test("populates wakefulness on success", async () => {
      fakeAdb.setScreenState(true, "Awake");
      const result = makeResult();
      await collector.collectWakefulness(result);
      expect(result.wakefulness).toBe("Awake");
    });

    test("does not append error on failure (logs only)", async () => {
      // Swap getWakefulness to throw
      (fakeAdb as any).getWakefulness = async () => {
        throw new Error("wake fail");
      };
      const result = makeResult();
      await collector.collectWakefulness(result);
      expect(result.wakefulness).toBeUndefined();
      expect(result.errors).toBeUndefined();
    });
  });

  describe("collectDeviceLock", () => {
    test("populates deviceLock on success (secure lock)", async () => {
      fakeAdb.setDeviceLock({ locked: true, keyguardShowing: true, secure: true });
      const result = makeResult();
      await collector.collectDeviceLock(result);
      expect(result.deviceLock).toEqual({ locked: true, keyguardShowing: true, secure: true });
    });

    test("carries secure=false through for a swipe-only lock", async () => {
      fakeAdb.setDeviceLock({ locked: true, keyguardShowing: true, secure: false });
      const result = makeResult();
      await collector.collectDeviceLock(result);
      expect(result.deviceLock?.secure).toBe(false);
    });

    test("leaves deviceLock unset when the lock state is unknown (adb returns null)", async () => {
      fakeAdb.setDeviceLock(null);
      const result = makeResult();
      await collector.collectDeviceLock(result);
      expect(result.deviceLock).toBeUndefined();
    });

    test("does not append error on failure (logs only)", async () => {
      (fakeAdb as any).getDeviceLock = async () => {
        throw new Error("lock fail");
      };
      const result = makeResult();
      await collector.collectDeviceLock(result);
      expect(result.deviceLock).toBeUndefined();
      expect(result.errors).toBeUndefined();
    });
  });

  describe("collectBackStack", () => {
    test("populates backStack on success", async () => {
      const result = makeResult();
      await collector.collectBackStack(result);
      expect(result.backStack).toBeDefined();
      expect(result.errors).toBeUndefined();
    });

    test("appends backStack error on failure", async () => {
      fakeBackStack.shouldFail = new Error("backstack fail");
      const result = makeResult();
      await collector.collectBackStack(result);
      expect(result.errors!.length).toBe(1);
      expect(result.errors![0].phase).toBe("backStack");
      expect(result.errors![0].message).toBe("Failed to retrieve back stack information");
    });
  });

  describe("collectActiveWindow", () => {
    test("uses the legacy window query only when the caller explicitly invokes the bootstrap fallback", async () => {
      fakeWindow.configureActiveWindow({
        appId: "com.example.app",
        activityName: "MainActivity",
        layoutSeqSum: 1,
      });
      const result = makeResult();

      await collector.collectActiveWindow(result);

      expect(result.activeWindow).toEqual({
        appId: "com.example.app",
        activityName: "MainActivity",
        layoutSeqSum: 1,
      });
    });
  });
});
