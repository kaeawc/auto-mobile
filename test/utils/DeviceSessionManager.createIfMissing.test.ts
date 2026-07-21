import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DeviceSessionManager } from "../../src/utils/DeviceSessionManager";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceCreationGate } from "../fakes/FakeDeviceCreationGate";
import { resetDeviceCreationGate, setDeviceCreationGate } from "../../src/utils/deviceCreationGate";
import type { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { BootedDevice } from "../../src/models";

interface SimctlRecorder {
  createCalls: { name: string; deviceType: string; runtime: string }[];
  bootCalls: string[];
}

/**
 * Minimal simctl stub reporting an EMPTY simulator list — the condition that
 * makes findOrStartIosDevice either throw or (when gated on) provision.
 */
function makeEmptySimctl(recorder: SimctlRecorder): SimCtlClient {
  return {
    listSimulatorImages: async () => [],
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
    getDeviceInfo: async () => ({ name: "AutoMobile-iPhone-17", isAvailable: true, state: "Shutdown" }),
  } as unknown as SimCtlClient;
}

describe("findOrStartIosDevice creation gate", () => {
  let recorder: SimctlRecorder;
  let manager: DeviceSessionManager;

  beforeEach(() => {
    recorder = { createCalls: [], bootCalls: [] };
    const provider = new FakeDeviceClientProvider(
      new FakeAdbExecutor(),
      new FakeDeviceUtils(),
      makeEmptySimctl(recorder),
    );
    manager = new DeviceSessionManager(provider);
  });

  afterEach(() => {
    resetDeviceCreationGate();
  });

  test("keeps the existing error and creates nothing when the gate is off", async () => {
    setDeviceCreationGate(new FakeDeviceCreationGate(false));

    await expect(manager.findOrStartIosDevice()).rejects.toThrow(
      "No iOS simulators are available. Please create an iOS simulator using Xcode or the Simulator app."
    );
    expect(recorder.createCalls).toEqual([]);
    expect(recorder.bootCalls).toEqual([]);
  });

  test("creates and boots a simulator when the gate is on", async () => {
    setDeviceCreationGate(new FakeDeviceCreationGate(true));

    const device = await manager.findOrStartIosDevice();

    expect(recorder.createCalls).toHaveLength(1);
    expect(recorder.createCalls[0].deviceType).toBe("com.apple.CoreSimulator.SimDeviceType.iPhone-17");
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
});
