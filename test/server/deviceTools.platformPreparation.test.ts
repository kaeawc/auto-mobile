import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getAndroidSchema,
  getAppleSchema,
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";

describe("platform device preparation tools", () => {
  let deviceUtils: FakeDeviceUtils;
  let matcher: FakeDeviceMatcher;
  let timer: FakeTimer;

  beforeEach(() => {
    deviceUtils = new FakeDeviceUtils();
    matcher = new FakeDeviceMatcher();
    timer = new FakeTimer();
    setDeviceToolsDependencies({
      deviceManagerFactory: () => deviceUtils,
      deviceMatcherFactory: () => matcher,
      ensureCtrlProxyReady: async () => {},
      notifyResourcesChanged: async () => {},
      timer,
    });
    registerDeviceTools();
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
  });

  async function callTool(name: "getAndroid" | "getApple", args: Record<string, unknown>) {
    const tool = ToolRegistry.getTool(name);
    if (!tool) {
      throw new Error(`${name} is not registered`);
    }
    const result = await tool.handler(args);
    return JSON.parse(
      typeof result === "string" ? result : ((result as any).content?.[0]?.text ?? "{}"),
    );
  }

  test("getAndroid returns the AVD to ADB serial and port mapping", async () => {
    const emulator: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5562",
      transportId: "17",
    };
    deviceUtils.setBootedDevices("android", [emulator]);
    matcher.setBootedResult(emulator);

    const result = await callTool("getAndroid", { avdName: "Pixel_9_API_36" });

    expect(result.sessionId).toBeDefined();
    expect(result.deviceIdentity).toEqual({
      platform: "android",
      avdName: "Pixel_9_API_36",
      adbSerial: "emulator-5562",
      emulatorConsolePort: 5562,
      adbTransportId: "17",
    });
  });

  test("getApple accepts only a simulator UDID and returns its simulator identity", async () => {
    const simulator: DeviceInfo = {
      platform: "ios",
      name: "iPhone 17",
      deviceId: "E2F46BCE-4C97-4AA0-BD9D-544756FAB545",
      isRunning: false,
    };
    deviceUtils.setDeviceImages("ios", [simulator]);

    const result = await callTool("getApple", { udid: simulator.deviceId });

    expect(result.deviceIdentity).toEqual({
      platform: "ios",
      simulatorUdid: simulator.deviceId,
      simulatorName: simulator.name,
    });
    expect(deviceUtils.getExecutedOperations()).toContain(`startDevice:${simulator.name}:120000`);
  });

  test("uses explicit boot and automation readiness budgets without accepting matcher inputs", async () => {
    const image: DeviceInfo = {
      platform: "android",
      name: "Pixel_9_API_36",
      isRunning: false,
    };
    let readinessRequest: { readinessTimeoutMs: number; totalDeadlineMs: number } | undefined;
    matcher.setImageResult(image);
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async (request) => {
        readinessRequest = {
          readinessTimeoutMs: request.readinessTimeoutMs,
          totalDeadlineMs: request.totalDeadlineMs,
        };
      },
    });

    await callTool("getAndroid", {
      avdName: image.name,
      bootTimeoutMs: 40_000,
      automationReadyTimeoutMs: 20_000,
    });

    expect(deviceUtils.getExecutedOperations()).toContain(`startDevice:${image.name}:40000`);
    expect(readinessRequest).toEqual({
      readinessTimeoutMs: 20_000,
      totalDeadlineMs: 60_000,
    });
    expect(() =>
      getAndroidSchema.parse({ avdName: image.name, deviceId: "emulator-5554" }),
    ).toThrow();
    expect(() => getAppleSchema.parse({ udid: "sim-udid", platform: "ios" })).toThrow();
  });
});
