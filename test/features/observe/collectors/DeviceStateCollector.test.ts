import { beforeEach, describe, expect, test } from "bun:test";
import { DeviceStateCollector } from "../../../../src/features/observe/collectors/DeviceStateCollector";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeWindow } from "../../../fakes/FakeWindow";
import { FakeTimer } from "../../../fakes/FakeTimer";
import type {
  BootedDevice,
  ExecResult,
  ObserveResult,
  ScreenSize as ScreenSizeModel,
  SystemInsets as SystemInsetsModel,
  BackStackInfo
} from "../../../../src/models";
import type { ScreenSize } from "../../../../src/features/observe/interfaces/ScreenSize";
import type { SystemInsets } from "../../../../src/features/observe/interfaces/SystemInsets";
import type { BackStack } from "../../../../src/features/observe/interfaces/BackStack";

function makeResult(): ObserveResult {
  return {
    updatedAt: 0,
    screenSize: { width: 0, height: 0 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 }
  };
}

function makeDevice(): BootedDevice {
  return {
    name: "test-device",
    platform: "android",
    deviceId: "test-device"
  } as BootedDevice;
}

function makeExecResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s)
  };
}

// Minimal inline fakes (not used elsewhere)

class FakeScreenSize implements ScreenSize {
  configured: ScreenSizeModel = { width: 1080, height: 2400 };
  shouldFail: Error | null = null;
  async execute(): Promise<ScreenSizeModel> {
    if (this.shouldFail) {
      throw this.shouldFail;
    }
    return this.configured;
  }
}

class FakeSystemInsets implements SystemInsets {
  configured: SystemInsetsModel = { top: 100, right: 0, bottom: 50, left: 0 };
  shouldFail: Error | null = null;
  async execute(): Promise<SystemInsetsModel> {
    if (this.shouldFail) {
      throw this.shouldFail;
    }
    return this.configured;
  }
}

class FakeBackStack implements BackStack {
  configured: BackStackInfo = {
    activities: [],
    tasks: [],
    currentActivity: null
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
  let fakeWindow: FakeWindow;
  let fakeScreenSize: FakeScreenSize;
  let fakeSystemInsets: FakeSystemInsets;
  let fakeBackStack: FakeBackStack;
  let fakeTimer: FakeTimer;
  let collector: DeviceStateCollector;

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeWindow = new FakeWindow();
    fakeScreenSize = new FakeScreenSize();
    fakeSystemInsets = new FakeSystemInsets();
    fakeBackStack = new FakeBackStack();
    fakeTimer = new FakeTimer();
    collector = new DeviceStateCollector({
      device: makeDevice(),
      screenSize: fakeScreenSize,
      systemInsets: fakeSystemInsets,
      window: fakeWindow,
      backStack: fakeBackStack,
      adb: fakeAdb,
      timer: fakeTimer
    });
  });

  describe("collectScreenSize", () => {
    test("populates result.screenSize on success", async () => {
      const result = makeResult();
      await collector.collectScreenSize(makeExecResult(""), result);
      expect(result.screenSize).toEqual({ width: 1080, height: 2400 });
      expect(result.errors).toBeUndefined();
    });

    test("appends screenSize error on failure", async () => {
      fakeScreenSize.shouldFail = new Error("nope");
      const result = makeResult();
      await collector.collectScreenSize(makeExecResult(""), result);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBe(1);
      expect(result.errors![0].phase).toBe("screenSize");
      expect(result.errors![0].message).toBe("Failed to retrieve screen dimensions");
      expect(result.errors![0].cause).toContain("nope");
    });
  });

  describe("collectSystemInsets", () => {
    test("populates result.systemInsets on success", async () => {
      const result = makeResult();
      await collector.collectSystemInsets(makeExecResult(""), result);
      expect(result.systemInsets).toEqual({ top: 100, right: 0, bottom: 50, left: 0 });
      expect(result.errors).toBeUndefined();
    });

    test("appends systemInsets error on failure", async () => {
      fakeSystemInsets.shouldFail = new Error("insets fail");
      const result = makeResult();
      await collector.collectSystemInsets(makeExecResult(""), result);
      expect(result.errors!.length).toBe(1);
      expect(result.errors![0].phase).toBe("systemInsets");
      expect(result.errors![0].message).toBe("Failed to retrieve system insets");
    });
  });

  describe("collectRotationInfo", () => {
    test("parses rotation from dumpsys window output", async () => {
      const result = makeResult();
      await collector.collectRotationInfo(makeExecResult("blah\nmRotation=3\nfoo"), result);
      expect(result.rotation).toBe(3);
    });

    test("does not set rotation when missing", async () => {
      const result = makeResult();
      await collector.collectRotationInfo(makeExecResult("no rotation here"), result);
      expect(result.rotation).toBeUndefined();
      expect(result.errors).toBeUndefined();
    });

    test("does not append error on parse problem (logs only)", async () => {
      // Construct exec result with broken stdout that .match throws on? .match is forgiving;
      // The legacy code only logged warnings. Verify we never write to result.errors.
      const result = makeResult();
      await collector.collectRotationInfo(makeExecResult(""), result);
      expect(result.errors).toBeUndefined();
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
    test("populates activeWindow on success", async () => {
      fakeWindow.configureActiveWindow({
        appId: "com.test.app",
        activityName: "MainActivity",
        layoutSeqSum: 1
      });
      const result = makeResult();
      await collector.collectActiveWindow(result);
      expect(result.activeWindow).toEqual({
        appId: "com.test.app",
        activityName: "MainActivity",
        layoutSeqSum: 1
      });
      expect(result.errors).toBeUndefined();
    });

    test("appends activeWindow error on failure", async () => {
      // FakeWindow.getActive throws when no activeWindow configured
      const result = makeResult();
      await collector.collectActiveWindow(result);
      expect(result.errors!.length).toBe(1);
      expect(result.errors![0].phase).toBe("activeWindow");
      expect(result.errors![0].message).toBe("Failed to retrieve active window information");
    });
  });
});
