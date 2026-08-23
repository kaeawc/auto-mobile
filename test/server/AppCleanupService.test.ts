import { describe, expect, test } from "bun:test";
import { BootedDevice, ClearAppDataResult, TerminateAppResult } from "../../src/models";
import { DefaultAppCleanupService } from "../../src/server/AppCleanupService";

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
