import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DeviceSessionManager } from "../../src/utils/DeviceSessionManager";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceCreationGate } from "../fakes/FakeDeviceCreationGate";
import { resetDeviceCreationGate, setDeviceCreationGate } from "../../src/utils/deviceCreationGate";
import type { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { BootedDevice, DeviceInfo } from "../../src/models";

interface SimctlRecorder {
  createCalls: { name: string; deviceType: string; runtime: string }[];
  bootCalls: string[];
}

/**
 * Minimal injected simctl fake. It never reaches a real simulator, and records
 * the creation and boot decisions made by findOrStartIosDevice.
 */
function makeSimctl(recorder: SimctlRecorder, simulatorImages: DeviceInfo[] = []): SimCtlClient {
  return {
    listSimulatorImages: async () => simulatorImages,
    getBootedSimulators: async () => [],
    getDeviceTypes: async () => [
      {
        name: "iPhone 17",
        identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        productFamily: "iPhone",
        bundlePath: "/tmp",
        minRuntimeVersion: 0,
        maxRuntimeVersion: 0,
      },
    ],
    resolveRuntimeIdentifier: async () => "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
    createSimulator: async (name: string, deviceType: string, runtime: string) => {
      recorder.createCalls.push({ name, deviceType, runtime });
      return "CREATED-UDID";
    },
    bootSimulator: async (udid: string): Promise<BootedDevice> => {
      recorder.bootCalls.push(udid);
      return { deviceId: udid, name: "AutoMobile-iPhone-17", platform: "ios" };
    },
    // verifyIosDevice returns early for a non-Booted, available device.
    getDeviceInfo: async () => ({
      name: "AutoMobile-iPhone-17",
      isAvailable: true,
      state: "Shutdown",
    }),
  } as unknown as SimCtlClient;
}

function simulatorImage(
  deviceId: string,
  isAvailable: boolean,
  availabilityError?: string,
): DeviceInfo {
  return {
    name: `iPhone ${deviceId}`,
    platform: "ios",
    isRunning: false,
    deviceId,
    state: "Shutdown",
    isAvailable,
    availabilityError,
  };
}

describe("findOrStartIosDevice creation gate", () => {
  let recorder: SimctlRecorder;
  let manager: DeviceSessionManager;

  beforeEach(() => {
    recorder = { createCalls: [], bootCalls: [] };
    const provider = new FakeDeviceClientProvider(
      new FakeAdbExecutor(),
      new FakeDeviceUtils(),
      makeSimctl(recorder),
    );
    manager = new DeviceSessionManager(provider);
  });

  afterEach(() => {
    resetDeviceCreationGate();
  });

  test("keeps the existing error and creates nothing when the gate is off", async () => {
    setDeviceCreationGate(new FakeDeviceCreationGate(false));

    await expect(manager.findOrStartIosDevice()).rejects.toThrow(
      "No iOS simulators are available. Please create an iOS simulator using Xcode or the Simulator app.",
    );
    expect(recorder.createCalls).toEqual([]);
    expect(recorder.bootCalls).toEqual([]);
  });

  test("creates and boots a simulator when the gate is on", async () => {
    setDeviceCreationGate(new FakeDeviceCreationGate(true));

    const device = await manager.findOrStartIosDevice();

    expect(recorder.createCalls).toHaveLength(1);
    expect(recorder.createCalls[0].deviceType).toBe(
      "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
    );
    expect(recorder.createCalls[0].runtime).toBe("com.apple.CoreSimulator.SimRuntime.iOS-26-3");
    expect(recorder.createCalls[0].name).toStartWith("AutoMobile-iPhone-17-");
    expect(recorder.bootCalls).toEqual(["CREATED-UDID"]);
    expect(device.deviceId).toBe("CREATED-UDID");
  });

  test("consults the gate with no explicit flag (env var only on this path)", async () => {
    const gate = new FakeDeviceCreationGate(false);
    setDeviceCreationGate(gate);

    await expect(manager.findOrStartIosDevice()).rejects.toThrow(/No iOS simulators are available/);
    expect(gate.calls).toEqual([undefined]);
  });

  test("boots an available simulator when an unavailable one sorts first", async () => {
    const provider = new FakeDeviceClientProvider(
      new FakeAdbExecutor(),
      new FakeDeviceUtils(),
      makeSimctl(recorder, [
        simulatorImage("000-unavailable", false, "runtime unavailable"),
        simulatorImage("999-available", true),
      ]),
    );
    manager = new DeviceSessionManager(provider);

    await manager.findOrStartIosDevice();

    expect(recorder.bootCalls).toEqual(["999-available"]);
  });

  test("provisions a replacement when every simulator image is unavailable and creation is enabled", async () => {
    const provider = new FakeDeviceClientProvider(
      new FakeAdbExecutor(),
      new FakeDeviceUtils(),
      makeSimctl(recorder, [simulatorImage("unavailable", false, "runtime unavailable")]),
    );
    manager = new DeviceSessionManager(provider);
    setDeviceCreationGate(new FakeDeviceCreationGate(true));

    await manager.findOrStartIosDevice();

    expect(recorder.createCalls).toHaveLength(1);
    expect(recorder.bootCalls).toEqual(["CREATED-UDID"]);
  });

  test("reports unavailable simulator diagnostics when creation is disabled", async () => {
    const provider = new FakeDeviceClientProvider(
      new FakeAdbExecutor(),
      new FakeDeviceUtils(),
      makeSimctl(recorder, [simulatorImage("unavailable", false, "runtime unavailable")]),
    );
    manager = new DeviceSessionManager(provider);
    setDeviceCreationGate(new FakeDeviceCreationGate(false));

    await expect(manager.findOrStartIosDevice()).rejects.toThrow(
      "No available iOS simulators. Unavailable simulators: iPhone unavailable (unavailable): runtime unavailable.",
    );
    expect(recorder.createCalls).toEqual([]);
    expect(recorder.bootCalls).toEqual([]);
  });
});
