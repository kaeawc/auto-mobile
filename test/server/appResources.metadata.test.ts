import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  APP_RESOURCE_TEMPLATES,
  invalidateInstalledAppsCache,
  registerAppResources,
  syncInstalledAppResources,
} from "../../src/server/appResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { BootedDevice } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { createExecResult } from "../../src/utils/execResult";

const device: BootedDevice = {
  deviceId: "metadata-resource-device",
  name: "Metadata test device",
  platform: "android",
};
const appId = "com.example.app";
const command = `shell dumpsys package '${appId}'`;

describe("app metadata resource ADB fallback", () => {
  let adb: FakeAdbExecutor;
  let adbSpy: ReturnType<typeof spyOn>;
  let ctrlProxySpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    const devices = new FakeDeviceUtils();
    devices.setBootedDevices("android", [device]);
    devices.setBootedDevices("ios", []);
    PlatformDeviceManagerFactory.setInstance(devices);
    adb = new FakeAdbExecutor();
    adbSpy = spyOn(defaultAdbClientFactory, "create").mockReturnValue(adb);
    ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(() => {
      throw new Error("CtrlProxy unavailable");
    });
    invalidateInstalledAppsCache(device.deviceId);
    ResourceRegistry.clearResources();
    registerAppResources();
    // Drain the asynchronous resource registration before exercising the handler.
    await syncInstalledAppResources();
  });

  afterEach(() => {
    adbSpy.mockRestore();
    ctrlProxySpy.mockRestore();
    PlatformDeviceManagerFactory.setInstance(null);
    invalidateInstalledAppsCache(device.deviceId);
    ResourceRegistry.clearResources();
  });

  async function readMetadata(): Promise<string> {
    const template = ResourceRegistry.getTemplate(APP_RESOURCE_TEMPLATES.DEVICE_APP_METADATA)!;
    const content = await template.handler!({ deviceId: device.deviceId, appId });
    expect(content.mimeType).toBe("application/json");
    expect(adb.getCommandCalls().map((call) => call.command)).toEqual([command]);
    return content.text!;
  }

  test.each(["device offline", "dumpsys timed out"])(
    "reports lookup failure instead of app absence when ADB fails: %s",
    async (reason) => {
      adb.setCommandError(command, new Error(reason));

      const text = await readMetadata();

      expect(text).toContain("Failed to get app metadata");
      expect(text).toContain(reason);
      expect(text).not.toContain("App not found");
    },
  );

  test("returns metadata for an installed app", async () => {
    adb.setCommandResponse(
      command,
      createExecResult("versionName=1.2.3\nversionCode=42\ncodePath=/data/app/com.example.app", ""),
    );

    expect(JSON.parse(await readMetadata())).toEqual({
      appId,
      platform: "android",
      versionName: "1.2.3",
      buildNumber: "42",
      installPath: "/data/app/com.example.app",
    });
  });

  test.each(["Unable to find package: com.example.app", ""])(
    "reports app absence for missing package output: %j",
    async (stdout) => {
      adb.setCommandResponse(command, createExecResult(stdout, ""));

      expect(JSON.parse(await readMetadata())).toEqual({ error: `App not found: ${appId}` });
    },
  );
});
