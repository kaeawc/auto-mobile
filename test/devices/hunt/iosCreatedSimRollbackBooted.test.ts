import { afterEach, describe, expect, test } from "bun:test";
import { DeviceSessionManager } from "../../../src/devices/DeviceSessionManager";
import {
  resetDeviceCreationGate,
  setDeviceCreationGate,
} from "../../../src/devices/deviceCreationGate";
import type { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeDeviceClientProvider } from "../../fakes/FakeDeviceClientProvider";
import { FakeDeviceCreationGate } from "../../fakes/FakeDeviceCreationGate";

/**
 * Stateful simctl fake: CoreSimulator refuses `delete` of a simulator that is not
 * Shutdown ("Unable to delete device in current state: Booted"), the same
 * state-machine rule the real client's `shutdown`/`boot` 405s encode.
 */
function statefulSimctl(state: { booted: Set<string>; deleted: Set<string>; calls: string[] }) {
  return {
    listSimulatorImages: async () => [],
    getBootedSimulators: async () => [],
    getBootedSimulatorsChecked: async () => [],
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
    resolveRuntimeIdentifiersForBounds: async () => ["com.apple.CoreSimulator.SimRuntime.iOS-26-3"],
    createSimulator: async () => "CREATED-UDID",
    bootSimulator: async (udid: string): Promise<BootedDevice> => {
      state.calls.push(`boot ${udid}`);
      state.booted.add(udid);
      return { deviceId: udid, name: "AutoMobile-iPhone-17", platform: "ios" };
    },
    presentSimulatorAfterStart: async () => {},
    killSimulator: async (device: BootedDevice) => {
      state.calls.push(`shutdown ${device.deviceId}`);
      state.booted.delete(device.deviceId);
    },
    deleteSimulator: async (udid: string) => {
      state.calls.push(`delete ${udid}`);
      if (state.booted.has(udid)) {
        throw new Error(
          "Unable to delete device in current state: Booted (domain=com.apple.CoreSimulator.SimError, code=405)",
        );
      }
      state.deleted.add(udid);
    },
    // The post-boot readiness check fails (runner never became ready).
    getDeviceInfo: async () => {
      throw new Error("runner readiness failed");
    },
  } as unknown as SimCtlClient;
}

describe("findOrStartIosDevice rollback of a created simulator that already booted", () => {
  afterEach(() => resetDeviceCreationGate());

  test("shuts the booted simulator down so the rollback delete can remove it", async () => {
    setDeviceCreationGate(new FakeDeviceCreationGate(true));
    const state = { booted: new Set<string>(), deleted: new Set<string>(), calls: [] as string[] };
    const manager = new DeviceSessionManager(
      new FakeDeviceClientProvider(
        new FakeAdbExecutor(),
        new FakeDeviceUtils(),
        statefulSimctl(state),
      ),
    );

    await expect(manager.findOrStartIosDevice()).rejects.toThrow();

    // Rollback must leave neither a Booted nor an undeleted created simulator behind.
    expect(state.calls).toContain("shutdown CREATED-UDID");
    expect(state.deleted.has("CREATED-UDID")).toBe(true);
    expect(state.booted.has("CREATED-UDID")).toBe(false);
  });
});
