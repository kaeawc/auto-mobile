import { describe, expect, test } from "bun:test";
import { ClearAppData } from "../../../src/features/action/ClearAppData";
import { BootedDevice } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const device: BootedDevice = {
  name: "test-device",
  platform: "android",
  deviceId: "device-123",
};

function adbFactoryFor(adb: FakeAdbExecutor): AdbClientFactory {
  return { create: () => adb };
}

describe("ClearAppData", () => {
  test("clears the explicitly requested Android user", async () => {
    const adb = new FakeAdbExecutor();
    const clearAppData = new ClearAppData(device, adbFactoryFor(adb));

    const result = await clearAppData.execute("com.example.app", 10);

    expect(result).toEqual({ success: true, packageName: "com.example.app", userId: 10 });
    expect(adb.getExecutedCommands()).toEqual(["shell pm clear --user 10 com.example.app"]);
  });

  test("uses the package foreground user when no user is explicitly requested", async () => {
    const adb = new FakeAdbExecutor();
    adb.setForegroundApp({ packageName: "com.example.app", userId: 11 });
    const clearAppData = new ClearAppData(device, adbFactoryFor(adb));

    const result = await clearAppData.execute("com.example.app");

    expect(result).toEqual({ success: true, packageName: "com.example.app", userId: 11 });
    expect(adb.getExecutedCommands()).toEqual(["shell pm clear --user 11 com.example.app"]);
  });

  test("returns a stable failure result when pm clear fails", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("shell pm clear --user 10 com.example.app", new Error("adb failed"));
    const clearAppData = new ClearAppData(device, adbFactoryFor(adb));

    const result = await clearAppData.execute("com.example.app", 10);

    expect(result).toEqual({
      success: false,
      packageName: "com.example.app",
      userId: 10,
      error: "Failed to clear application data",
    });
  });
});
