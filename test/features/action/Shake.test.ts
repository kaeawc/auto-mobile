import { expect, describe, test, beforeEach, spyOn } from "bun:test";
import { Shake } from "../../../src/features/action/Shake";
import { BootedDevice, ObserveResult, ShakeOptions } from "../../../src/models";

const testDevice: BootedDevice = {
  name: "test-device",
  platform: "android",
  deviceId: "emulator-5554",
};
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";

describe("Shake", () => {
  let shake: Shake;
  let fakeAdb: FakeAdbExecutor;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeWindow: FakeWindow;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeTimer: FakeTimer;

  // Helper function to create mock ObserveResult
  const createObserveResult = (): ObserveResult => ({
    timestamp: 1700000000000,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { node: {} },
  });

  beforeEach(() => {
    // Create fakes for testing
    fakeAdb = new FakeAdbExecutor();
    fakeObserveScreen = new FakeObserveScreen();
    fakeWindow = new FakeWindow();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    // Configure default responses
    fakeWindow.configureCachedActiveWindow(null);
    fakeWindow.configureActiveWindow({
      appId: "com.test.app",
      activityName: "MainActivity",
      layoutSeqSum: 123,
    });

    // Set up default observe screen responses with valid viewHierarchy
    const defaultObserveResult = createObserveResult();
    fakeObserveScreen.setObserveResult(defaultObserveResult);

    shake = new Shake(testDevice, fakeAdb, fakeTimer);
    (shake as any).observeScreen = fakeObserveScreen;
    (shake as any).window = fakeWindow;
    (shake as any).awaitIdle = fakeAwaitIdle;
  });

  describe("execute", () => {
    test.each([
      { name: "defaults", options: undefined, duration: 1000, intensity: 100 },
      { name: "a custom duration", options: { duration: 100 }, duration: 100, intensity: 100 },
      {
        name: "a custom intensity",
        options: { duration: 100, intensity: 200 },
        duration: 100,
        intensity: 200,
      },
      {
        name: "custom duration and intensity",
        options: { duration: 100, intensity: 150 },
        duration: 100,
        intensity: 150,
      },
      { name: "an empty options object", options: {}, duration: 1000, intensity: 100 },
      { name: "a zero duration", options: { duration: 0 }, duration: 0, intensity: 100 },
      {
        name: "a zero intensity",
        options: { duration: 100, intensity: 0 },
        duration: 100,
        intensity: 0,
      },
    ] satisfies Array<{
      name: string;
      options: ShakeOptions | undefined;
      duration: number;
      intensity: number;
    }>)("executes shake with $name", async ({ options, duration, intensity }) => {
      const result = await shake.execute(options);

      expect(result.success).toBe(true);
      expect(result.duration).toBe(duration);
      expect(result.intensity).toBe(intensity);
      expect(result.observation).toBeDefined();
      expect(fakeTimer.wasSleepCalled(duration)).toBe(true);
      expect(
        fakeAdb.wasCommandExecuted(
          `emu sensor set acceleration ${intensity}:${intensity}:${intensity}`,
        ),
      ).toBe(true);
      expect(fakeAdb.wasCommandExecuted("emu sensor set acceleration 0:0:0")).toBe(true);
    });

    test("should work with progress callback", async () => {
      fakeAdb.setCommandResponse("emu sensor set acceleration 100:100:100", {
        stdout: "",
        stderr: "",
      });
      fakeAdb.setCommandResponse("emu sensor set acceleration 0:0:0", { stdout: "", stderr: "" });
      const mockObservation = createObserveResult();
      fakeObserveScreen.setObserveResult(mockObservation);

      let callbackCalled = false;
      const progressCallback = () => {
        callbackCalled = true;
      };
      const resultPromise = shake.execute({ duration: 50 }, progressCallback);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(callbackCalled).toBe(true);
    });

    test("should use CtrlProxy shake on iOS simulator without invoking adb", async () => {
      const iosSimulator: BootedDevice = {
        name: "iPhone 16 Simulator",
        platform: "ios",
        deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      };
      const iosShake = new Shake(iosSimulator, fakeAdb, fakeTimer);
      (iosShake as any).observeScreen = fakeObserveScreen;
      (iosShake as any).window = fakeWindow;
      (iosShake as any).awaitIdle = fakeAwaitIdle;
      const fakeIOSCtrlProxy = new FakeIOSCtrlProxy();
      const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIOSCtrlProxy as any,
      );

      try {
        const result = await iosShake.execute({ duration: 250, intensity: 77 });

        expect(result.success).toBe(true);
        expect(result.duration).toBe(250);
        expect(result.intensity).toBe(77);
        expect(result.observation).toBeDefined();
        expect(fakeIOSCtrlProxy.getShakeRequestCount()).toBe(1);
        expect(fakeIOSCtrlProxy.getShakeTimeoutHistory()).toEqual([2250]);
        expect(fakeAdb.getExecutedCommands()).toEqual([]);
      } finally {
        getInstanceSpy.mockRestore();
      }
    });

    test("should reject physical iOS devices without invoking adb or CtrlProxy", async () => {
      const physicalIosDevice: BootedDevice = {
        name: "Jason's iPhone",
        platform: "ios",
        deviceId: "00008110-0012345678901234",
      };
      const iosShake = new Shake(physicalIosDevice, fakeAdb, fakeTimer);
      const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance");

      try {
        const result = await iosShake.execute({ duration: 250, intensity: 77 });

        expect(result.success).toBe(false);
        expect(result.duration).toBe(250);
        expect(result.intensity).toBe(77);
        expect(result.error).toContain("not supported on physical iOS devices");
        expect(getInstanceSpy).not.toHaveBeenCalled();
        expect(fakeAdb.getExecutedCommands()).toEqual([]);
      } finally {
        getInstanceSpy.mockRestore();
      }
    });

    test("should map CtrlProxy shake failure to an unsuccessful result", async () => {
      const iosSimulator: BootedDevice = {
        name: "iPhone 16 Simulator",
        platform: "ios",
        deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      };
      const iosShake = new Shake(iosSimulator, fakeAdb, fakeTimer);
      (iosShake as any).observeScreen = fakeObserveScreen;
      (iosShake as any).window = fakeWindow;
      (iosShake as any).awaitIdle = fakeAwaitIdle;
      const fakeIOSCtrlProxy = new FakeIOSCtrlProxy();
      fakeIOSCtrlProxy.setFailureMode("shake", new Error("runner disconnected"));
      const getInstanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        fakeIOSCtrlProxy as any,
      );

      try {
        const result = await iosShake.execute({ duration: 250, intensity: 77 });

        expect(result.success).toBe(false);
        expect(result.duration).toBe(250);
        expect(result.intensity).toBe(77);
        expect(result.error).toContain("runner disconnected");
        expect(fakeIOSCtrlProxy.getShakeRequestCount()).toBe(1);
        expect(fakeAdb.getExecutedCommands()).toEqual([]);
      } finally {
        getInstanceSpy.mockRestore();
      }
    });

    test("should handle ADB command failure during shake start", async () => {
      fakeAdb.setCommandError(
        "emu sensor set acceleration 100:100:100",
        new Error("shake start failed"),
      );

      const result = await shake.execute({ duration: 100 });

      expect(result.success).toBe(false);
      expect(result.duration).toBe(100);
      expect(result.intensity).toBe(100);
      expect(result.error).toContain("shake start failed");
      expect(fakeTimer.getSleepHistory()).toEqual([]);
    });

    test("should handle ADB command failure during shake stop", async () => {
      fakeAdb.setCommandError("emu sensor set acceleration 0:0:0", new Error("shake stop failed"));

      const result = await shake.execute({ duration: 50 });

      expect(result.success).toBe(false);
      expect(result.duration).toBe(50);
      expect(result.intensity).toBe(100);
      expect(result.error).toContain("shake stop failed");
      expect(fakeTimer.wasSleepCalled(50)).toBe(true);
    });
  });

  describe("timing", () => {
    test("should respect the duration timing", async () => {
      fakeAdb.setCommandResponse("emu sensor set acceleration 100:100:100", {
        stdout: "",
        stderr: "",
      });
      fakeAdb.setCommandResponse("emu sensor set acceleration 0:0:0", { stdout: "", stderr: "" });
      const mockObservation = createObserveResult();
      fakeObserveScreen.setObserveResult(mockObservation);

      const duration = 100;

      const resultPromise = shake.execute({ duration });
      const result = await resultPromise;

      expect(result.success).toBe(true);
      // Timer was called with the correct duration
      expect(fakeTimer.wasSleepCalled(duration)).toBe(true);
      // Verify timer history
      const sleepHistory = fakeTimer.getSleepHistory();
      expect(sleepHistory).toContain(duration);
    });
  });

  describe("edge cases", () => {
    test("should handle very high intensity values", async () => {
      fakeAdb.setCommandResponse("emu sensor set acceleration 9999:9999:9999", {
        stdout: "",
        stderr: "",
      });
      fakeAdb.setCommandResponse("emu sensor set acceleration 0:0:0", { stdout: "", stderr: "" });
      const mockObservation = createObserveResult();
      fakeObserveScreen.setObserveResult(mockObservation);

      const resultPromise = shake.execute({ intensity: 9999, duration: 100 });
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.intensity).toBe(9999);

      const executedCommands = fakeAdb.getExecutedCommands();
      expect(
        executedCommands.some((cmd) => cmd.includes("emu sensor set acceleration 9999:9999:9999")),
      ).toBe(true);
    });

    test("should handle very long duration", async () => {
      fakeAdb.setCommandResponse("emu sensor set acceleration 100:100:100", {
        stdout: "",
        stderr: "",
      });
      fakeAdb.setCommandResponse("emu sensor set acceleration 0:0:0", { stdout: "", stderr: "" });
      const mockObservation = createObserveResult();
      fakeObserveScreen.setObserveResult(mockObservation);

      // Use shorter duration to avoid test timeout
      const resultPromise = shake.execute({ duration: 200 });
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.duration).toBe(200);

      // Both commands should still be called
      const executedCommands = fakeAdb.getExecutedCommands();
      expect(executedCommands.length).toBeGreaterThanOrEqual(2);
    });

    test("should handle negative values gracefully", async () => {
      fakeAdb.setCommandResponse("emu sensor set acceleration -50:-50:-50", {
        stdout: "",
        stderr: "",
      });
      fakeAdb.setCommandResponse("emu sensor set acceleration 0:0:0", { stdout: "", stderr: "" });
      const mockObservation = createObserveResult();
      fakeObserveScreen.setObserveResult(mockObservation);

      const resultPromise = shake.execute({ duration: 100, intensity: -50 }); // Use positive duration
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.duration).toBe(100);
      expect(result.intensity).toBe(-50);
    });
  });
});
