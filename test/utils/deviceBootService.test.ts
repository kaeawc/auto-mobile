import { describe, expect, it } from "bun:test";
import { DeviceBootService } from "../../src/utils/deviceBootService";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import type { DeviceInfo } from "../../src/models";
import type { DeviceMatchCriteria } from "../../src/models/DeviceMatchCriteria";
import type { DeviceBootRecovery } from "../../src/utils/deviceBootRecovery";

const image: DeviceInfo = {
  name: "Pixel_9_API_35",
  platform: "android",
  isRunning: false,
  osVersion: "35",
};

function service(deviceManager: FakeDeviceUtils, matcher = new FakeDeviceMatcher(), bootRecovery?: DeviceBootRecovery): DeviceBootService {
  return new DeviceBootService({
    deviceManager,
    deviceMatcher: matcher,
    deviceCreationGate: { isCreationAllowed: () => false, describeSource: () => "test" },
    deviceProvisioner: { provision: async () => { throw new Error("unexpected provision"); } },
    matchingStrategy: "LATEST",
    bootRecovery,
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
    expect(result.sourceImage).toBe(image);
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
    expect(result.sourceImage).toBeUndefined();
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

  it("applies an injected recovery policy at the cold product boot boundary", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const recovered: string[] = [];
    devices.setDeviceImages("android", [image]);
    matcher.setImageResult(image);
    const bootRecovery: DeviceBootRecovery = {
      run: async (target, boot) => {
        recovered.push(target.name);
        return boot();
      },
    };

    await service(devices, matcher, bootRecovery).boot({ platform: "android" });

    expect(recovered).toEqual([image.name]);
  });

  it("applies an injected recovery policy while awaiting an adopted running device", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const running = { name: image.name, platform: "android" as const, deviceId: "emulator-5554" };
    const recovered: string[] = [];
    devices.setDeviceImages("android", [image]);
    devices.setBootedDevices("android", [running]);
    matcher.setBootedResult(running);
    const bootRecovery: DeviceBootRecovery = {
      run: async (target, boot) => {
        recovered.push(target.deviceId ?? target.name);
        return boot();
      },
    };

    await service(devices, matcher, bootRecovery).boot({ platform: "android" });

    expect(recovered).toEqual(["emulator-5554"]);
  });

  it("cold-boots an adopted device after recovery erases its failed readiness state", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    const running = { name: image.name, platform: "android" as const, deviceId: "emulator-5554" };
    devices.setDeviceImages("android", [image]);
    devices.setBootedDevices("android", [running]);
    matcher.setBootedResult(running);
    let attempts = 0;
    const originalWaitForDeviceReady = devices.waitForDeviceReady.bind(devices);
    devices.waitForDeviceReady = async (...args) => {
      attempts++;
      if (attempts === 1) { throw new Error("not ready"); }
      return originalWaitForDeviceReady(...args);
    };
    const bootRecovery: DeviceBootRecovery = {
      run: async (_target, boot) => {
        try { return await boot(); } catch { return boot(); }
      },
    };

    const result = await service(devices, matcher, bootRecovery).boot({ platform: "android", timeoutMs: 12_345 });

    expect(result.source).toBe("cold-boot");
    expect(devices.getExecutedOperations()).toContain("startDevice:Pixel_9_API_35:12345");
  });

  it("preserves named CI runtime bounds when provisioning after a relaxed named match", async () => {
    const devices = new FakeDeviceUtils();
    const matcher = new FakeDeviceMatcher();
    let provisionCriteria: DeviceMatchCriteria | undefined;
    const bootService = new DeviceBootService({
      deviceManager: devices,
      deviceMatcher: matcher,
      deviceCreationGate: { isCreationAllowed: () => true, describeSource: () => "test" },
      deviceProvisioner: {
        provision: async criteria => {
          provisionCriteria = criteria;
          return { platform: "ios", name: "AutoMobile CI iPhone", deviceId: "CI-UDID", deviceType: "iPhone", runtime: "iOS-26-3" };
        },
      },
      matchingStrategy: "LATEST",
    });

    await bootService.boot({
      platform: "ios",
      name: "AutoMobile CI iPhone (com.apple.CoreSimulator.SimRuntime.iOS-26-3)",
      minOsVersion: "26.3",
      maxOsVersion: "26.3",
      matchNamedDeviceIgnoringOsVersion: true,
      createIfMissing: true,
    });

    expect(provisionCriteria).toMatchObject({ minOsVersion: "26.3", maxOsVersion: "26.3" });
  });
});
