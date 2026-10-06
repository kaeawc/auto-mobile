import { describe, expect, test } from "bun:test";
import {
  ActionableError,
  AppNotInstalledError,
  BootedDevice,
  ClearAppDataResult,
  TerminateAppResult,
} from "../../src/models";
import { DefaultAppCleanupService } from "../../src/server/AppCleanupService";
import { ClearAppData } from "../../src/features/action/ClearAppData";
import { NoOpPerformanceTracker } from "../../src/utils/PerformanceTracker";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeLogger } from "../fakes/FakeLogger";

class FakeClearAppData {
  public calls: string[] = [];
  private result: ClearAppDataResult;

  constructor(result: ClearAppDataResult) {
    this.result = result;
  }

  async execute(appId: string): Promise<ClearAppDataResult> {
    this.calls.push(appId);
    return this.result;
  }
}

class FakeTerminateApp {
  public calls: {
    appId: string;
    options?: { skipObservation?: boolean; skipUiStability?: boolean };
  }[] = [];
  private result: TerminateAppResult;

  constructor(result: TerminateAppResult) {
    this.result = result;
  }

  async execute(
    appId: string,
    options?: { skipObservation?: boolean; skipUiStability?: boolean },
  ): Promise<TerminateAppResult> {
    this.calls.push({ appId, options });
    return this.result;
  }
}

const androidDevice: BootedDevice = {
  name: "Pixel 7",
  platform: "android",
  deviceId: "emulator-5554",
};

const iosDevice: BootedDevice = {
  name: "iPhone 15",
  platform: "ios",
  deviceId: "ios-123",
};

describe("DefaultAppCleanupService", () => {
  test.each([true, false])(
    "clears a personal-only app best-effort (installed: %s)",
    async (installed) => {
      const adb = new FakeAdbExecutor();
      adb.setForegroundApp({ packageName: "com.example.other", userId: 0 });
      adb.setUsers([
        { userId: 0, name: "Owner", flags: 0x13, running: true },
        { userId: 10, name: "Work", flags: 0x30, running: true },
      ]);
      adb.setCommandResponse("shell pm list packages --user 0", {
        stdout: installed ? "package:com.example.app" : "package:com.example.other",
        stderr: "",
      });
      adb.setCommandResponse("shell pm list packages --user 10", {
        stdout: "package:com.example.other",
        stderr: "",
      });
      adb.setCommandResponse("shell pm clear", { stdout: "Success\n", stderr: "" });
      const log = new FakeLogger();
      const cleanupService = new DefaultAppCleanupService({
        createClearAppData: (targetDevice) =>
          new ClearAppData(
            targetDevice,
            new FakeAdbClientFactory(adb),
            { cacheInvalidator: { invalidate: () => {} } },
            () => new NoOpPerformanceTracker(),
          ),
        logger: log,
      });

      // Contract change (follow-up to #10022): cleanup returns a typed per-device outcome, not void.
      await expect(
        cleanupService.cleanup(androidDevice, { appId: "com.example.app", clearAppData: true }),
      ).resolves.toEqual({ status: "cleaned" });
      expect(
        adb.getExecutedCommands().filter((command) => command.startsWith("shell pm clear ")),
      ).toEqual(installed ? ["shell pm clear --user 0 'com.example.app'"] : []);
      expect(log.at("warn")).toHaveLength(installed ? 0 : 1);
      if (!installed) {
        expect(log.at("warn")[0].message).toContain(
          "App com.example.app is not installed for Android user 10",
        );
      }
    },
  );

  test.each(["result", "throw"])("logs a clear-data %s failure and continues", async (outcome) => {
    const log = new FakeLogger();
    const cleanupService = new DefaultAppCleanupService({
      createClearAppData: () => ({
        execute: async () => {
          if (outcome === "throw") {
            throw new ActionableError("App is not installed");
          }
          return { success: false, packageName: "com.example.app", error: "App is not installed" };
        },
      }),
      logger: log,
    });
    // Contract change (follow-up to #10022): a failure is reported to the caller, not only logged.
    await expect(
      cleanupService.cleanup(androidDevice, { appId: "com.example.app", clearAppData: true }),
    ).resolves.toEqual({
      status: "failed",
      step: "clearAppData",
      reason: "App is not installed",
    });
    expect(log.at("warn")).toHaveLength(1);
    expect(log.at("warn")[0].message).toContain("com.example.app");
    expect(log.at("warn")[0].message).toContain("App is not installed");
    expect(log.at("info")).toHaveLength(0);
  });

  test("an app that is not installed has nothing to clear and counts as cleaned", async () => {
    const log = new FakeLogger();
    const cleanupService = new DefaultAppCleanupService({
      createClearAppData: () => ({
        execute: async () => {
          throw new AppNotInstalledError("App com.example.app is not installed");
        },
      }),
      logger: log,
    });
    await expect(
      cleanupService.cleanup(androidDevice, { appId: "com.example.app", clearAppData: true }),
    ).resolves.toEqual({ status: "cleaned" });
    expect(log.at("warn")).toHaveLength(1);
  });

  test.each(["result", "throw"])(
    "reports a terminate %s failure as a failed outcome and logs it",
    async (outcome) => {
      const log = new FakeLogger();
      const cleanupService = new DefaultAppCleanupService({
        createTerminateApp: () => ({
          execute: async () => {
            if (outcome === "throw") {
              throw new ActionableError("adb offline");
            }
            return {
              success: false,
              packageName: "com.example.app",
              wasInstalled: true,
              wasRunning: true,
              wasForeground: false,
              error: "adb offline",
            };
          },
        }),
        logger: log,
      });
      await expect(
        cleanupService.cleanup(androidDevice, { appId: "com.example.app" }),
      ).resolves.toEqual({ status: "failed", step: "terminateApp", reason: "adb offline" });
      expect(log.at("warn")).toHaveLength(1);
      expect(log.at("warn")[0].message).toContain("adb offline");
    },
  );

  test("a failed terminate without an error message reports an unknown-error reason", async () => {
    const cleanupService = new DefaultAppCleanupService({
      createTerminateApp: () => ({
        execute: async () => ({
          success: false,
          packageName: "com.example.app",
          wasInstalled: true,
          wasRunning: true,
          wasForeground: false,
        }),
      }),
      logger: { info: () => {}, warn: () => {} },
    });
    await expect(
      cleanupService.cleanup(androidDevice, { appId: "com.example.app" }),
    ).resolves.toEqual({ status: "failed", step: "terminateApp", reason: "unknown error" });
  });

  test("an empty appId is a no-op that counts as cleaned", async () => {
    const cleanupService = new DefaultAppCleanupService({
      createTerminateApp: () => {
        throw new Error("must not run");
      },
      logger: { info: () => {}, warn: () => {} },
    });
    await expect(cleanupService.cleanup(androidDevice, { appId: "" })).resolves.toEqual({
      status: "cleaned",
    });
  });

  test("terminates app by default", async () => {
    const terminate = new FakeTerminateApp({
      success: true,
      packageName: "com.example.app",
      wasInstalled: true,
      wasRunning: true,
      wasForeground: false,
    });
    const clear = new FakeClearAppData({
      success: true,
      packageName: "com.example.app",
    });
    const cleanupService = new DefaultAppCleanupService({
      createTerminateApp: () => terminate,
      createClearAppData: () => clear,
      logger: { info: () => {}, warn: () => {} },
    });

    await cleanupService.cleanup(androidDevice, { appId: "com.example.app" });

    expect(terminate.calls).toHaveLength(1);
    expect(terminate.calls[0]).toEqual({
      appId: "com.example.app",
      options: { skipObservation: true, skipUiStability: true },
    });
    expect(clear.calls).toHaveLength(0);
  });

  test("clears app data when requested on Android", async () => {
    const terminate = new FakeTerminateApp({
      success: true,
      packageName: "com.example.app",
      wasInstalled: true,
      wasRunning: true,
      wasForeground: false,
    });
    const clear = new FakeClearAppData({
      success: true,
      packageName: "com.example.app",
    });
    const cleanupService = new DefaultAppCleanupService({
      createTerminateApp: () => terminate,
      createClearAppData: () => clear,
      logger: { info: () => {}, warn: () => {} },
    });

    await cleanupService.cleanup(androidDevice, {
      appId: "com.example.app",
      clearAppData: true,
    });

    expect(clear.calls).toEqual(["com.example.app"]);
    expect(terminate.calls).toHaveLength(0);
  });

  test("clears app data on iOS via the injected clear action", async () => {
    const terminate = new FakeTerminateApp({
      success: true,
      packageName: "com.example.app",
      wasInstalled: true,
      wasRunning: true,
      wasForeground: false,
    });
    const clear = new FakeClearAppData({
      success: true,
      packageName: "com.example.app",
    });
    const clearDevices: BootedDevice[] = [];
    const cleanupService = new DefaultAppCleanupService({
      createTerminateApp: () => terminate,
      createClearAppData: (device) => {
        clearDevices.push(device);
        return clear;
      },
    });

    await cleanupService.cleanup(iosDevice, {
      appId: "com.example.app",
      clearAppData: true,
    });

    // iOS now flows through the shared clear path instead of being skipped.
    expect(clearDevices).toEqual([iosDevice]);
    expect(clear.calls).toEqual(["com.example.app"]);
    expect(terminate.calls).toHaveLength(0);
  });
});
