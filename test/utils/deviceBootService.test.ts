import { describe, expect, it } from "bun:test";
import { DeviceBootService } from "../../src/utils/deviceBootService";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import type { DeviceInfo } from "../../src/models";

const image: DeviceInfo = {
  name: "Pixel_9_API_35",
  platform: "android",
  isRunning: false,
  osVersion: "35",
};

function service(deviceManager: FakeDeviceUtils, matcher = new FakeDeviceMatcher()): DeviceBootService {
  return new DeviceBootService({
    deviceManager,
    deviceMatcher: matcher,
    deviceCreationGate: { isCreationAllowed: () => false, describeSource: () => "test" },
    deviceProvisioner: { provision: async () => { throw new Error("unexpected provision"); } },
    matchingStrategy: "LATEST",
  });
}

describe("DeviceBootService", () => {
  it("cold-boots and awaits readiness without MCP-only side effects", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    devices.setDeviceImages("android", [image]);
    matcher.setImageResult(image);

    const result = await service(devices, matcher).boot({ platform: "android", timeoutMs: 12_345 });

    expect(result.source).toBe("cold-boot");
    expect(result.processId).toBe(12345);
    expect(devices.getExecutedOperations()).toEqual([
      "listDeviceImages:android",
      "getBootedDevices:android",
      "startDevice:Pixel_9_API_35:12345",
      "waitForDeviceReady:Pixel_9_API_35:12345",
    ]);
  });

  it("adopts and awaits a matching running device", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const running = { name: image.name, platform: "android" as const, deviceId: "emulator-5554" };
    devices.setDeviceImages("android", [image]);
    devices.setBootedDevices("android", [running]);
    matcher.setBootedResult(running);

    const result = await service(devices, matcher).boot({ platform: "android" });

    expect(result.source).toBe("booted");
    expect(result.processId).toBeUndefined();
    expect(devices.getExecutedOperations()).toContain("waitForDeviceReady:Pixel_9_API_35:120000");
  });

  it("cancels a failed cold boot through its launch handle", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    let killed = false;
    devices.setDeviceImages("android", [image]);
    matcher.setImageResult(image);
    devices.setMockChildProcess(image.name, { kill: () => { killed = true; return true; }, pid: 12 } as any);
    devices.setWaitForDeviceReadyError(new Error("not ready"));

    await expect(service(devices, matcher).boot({ platform: "android" })).rejects.toThrow("not ready");
    expect(killed).toBe(true);
  });
});
