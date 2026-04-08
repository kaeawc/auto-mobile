import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { setDeviceToolsDependencies, resetDeviceToolsDependencies, registerDeviceTools, startDeviceSchema } from "../../src/server/deviceTools";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice, DeviceInfo } from "../../src/models";

describe("startDevice handler", () => {
  let fakeDeviceUtils: FakeDeviceUtils;
  let fakeMatcher: FakeDeviceMatcher;

  beforeEach(() => {
    fakeDeviceUtils = new FakeDeviceUtils();
    fakeMatcher = new FakeDeviceMatcher();

    setDeviceToolsDependencies({
      deviceManagerFactory: () => fakeDeviceUtils,
      deviceMatcherFactory: () => fakeMatcher,
      notifyResourcesChanged: async () => {},
    });

    registerDeviceTools();
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
  });

  async function callStartDevice(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tool = ToolRegistry.getTool("startDevice");
    if (!tool) {throw new Error("startDevice not registered");}
    const result = await tool.handler(args);
    return JSON.parse(typeof result === "string" ? result : (result as any).content?.[0]?.text ?? "{}");
  }

  const androidDevice: BootedDevice = {
    name: "Pixel_7_API_34",
    platform: "android",
    deviceId: "emulator-5554",
    osVersion: "14",
    formFactor: "phone",
    screenWidth: 1080,
    screenHeight: 2400,
  };

  const androidImage: DeviceInfo = {
    name: "Pixel_7_API_34",
    platform: "android",
    isRunning: false,
    osVersion: "14",
    formFactor: "phone",
    screenWidth: 1080,
    screenHeight: 2400,
  };

  const iosDevice: BootedDevice = {
    name: "iPhone 15",
    platform: "ios",
    deviceId: "ABCD-1234",
    iosVersion: "17.2",
    osVersion: "17.2",
    formFactor: "phone",
  };

  it("matches a booted device by criteria", async () => {
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeMatcher.setBootedResult(androidDevice);

    const result = await callStartDevice({ platform: "android" });

    expect(result.deviceId).toBe("emulator-5554");
    expect(result.name).toBe("Pixel_7_API_34");
    expect(result.platform).toBe("android");
    expect(result.isReady).toBe(true);
    expect(result.source).toBe("booted");
    expect(result.osVersion).toBe("14");
    expect(result.sessionId).toBeDefined();
    expect(typeof result.sessionId).toBe("string");
  });

  it("falls through to image when no booted device matches", async () => {
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setDeviceImages("android", [androidImage]);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(androidImage);

    const result = await callStartDevice({ platform: "android" });

    expect(result.deviceId).toBeDefined();
    expect(result.source).toBe("cold-boot");
    expect(fakeDeviceUtils.wasMethodCalled("startDevice")).toBe(true);
  });

  it("finds device by direct deviceId", async () => {
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);

    const result = await callStartDevice({
      platform: "android",
      deviceId: "emulator-5554",
    });

    expect(result.deviceId).toBe("emulator-5554");
    expect(result.source).toBe("booted");
  });

  it("boots image when deviceId matches an image name", async () => {
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setDeviceImages("android", [androidImage]);

    const result = await callStartDevice({
      platform: "android",
      deviceId: "Pixel_7_API_34",
    });

    expect(result.source).toBe("cold-boot");
    expect(fakeDeviceUtils.wasMethodCalled("startDevice")).toBe(true);
  });

  it("throws when deviceId not found", async () => {
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setDeviceImages("android", []);

    await expect(
      callStartDevice({ platform: "android", deviceId: "nonexistent" })
    ).rejects.toThrow(/not found/);
  });

  it("throws when no device matches criteria", async () => {
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setDeviceImages("android", [androidImage]);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(null);

    await expect(
      callStartDevice({ platform: "android", minOsVersion: "99" })
    ).rejects.toThrow(/No android device matching criteria/);
  });

  it("skips booted devices when preferRunning is false", async () => {
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeDeviceUtils.setDeviceImages("android", [androidImage]);
    fakeMatcher.setImageResult(androidImage);

    const result = await callStartDevice({
      platform: "android",
      preferRunning: false,
    });

    expect(result.source).toBe("cold-boot");
    expect(fakeDeviceUtils.wasMethodCalled("startDevice")).toBe(true);
  });

  it("returns structured metadata with screen size", async () => {
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeMatcher.setBootedResult(androidDevice);

    const result = await callStartDevice({ platform: "android" });

    expect(result.formFactor).toBe("phone");
    expect(result.screenSize).toEqual({ width: 1080, height: 2400 });
  });

  it("handles iOS devices correctly", async () => {
    fakeDeviceUtils.setBootedDevices("ios", [iosDevice]);
    fakeMatcher.setBootedResult(iosDevice);

    const result = await callStartDevice({ platform: "ios" });

    expect(result.deviceId).toBe("ABCD-1234");
    expect(result.platform).toBe("ios");
    expect(result.osVersion).toBe("17.2");
  });

  it("requires iOS deviceId for cold boot", async () => {
    const iosImageNoId: DeviceInfo = {
      name: "iPhone 15",
      platform: "ios",
      isRunning: false,
    };
    fakeDeviceUtils.setBootedDevices("ios", []);
    fakeDeviceUtils.setDeviceImages("ios", [iosImageNoId]);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(iosImageNoId);

    await expect(
      callStartDevice({ platform: "ios" })
    ).rejects.toThrow(/UDID/);
  });

  it("accepts legacy nested device payloads", async () => {
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeMatcher.setBootedResult(androidDevice);

    const result = await callStartDevice({
      device: {
        name: "Pixel_7_API_34",
        platform: "android",
      },
    });

    expect(result.deviceId).toBe("emulator-5554");
    expect(result.source).toBe("booted");
  });

  it("prefers top-level values over legacy nested device payload values", () => {
    const parsed = startDeviceSchema.parse({
      platform: "ios",
      device: {
        platform: "android",
        name: "Pixel_7_API_34",
      },
    });

    expect(parsed.platform).toBe("ios");
    expect(parsed.name).toBe("Pixel_7_API_34");
  });
});
