import { expect, test } from "bun:test";
import { rebootAndroidAfterSystemUiAnr } from "../../src/server/deviceToolsSystemUiAnr";
import { getHostEmulatorProcessStopper } from "../../src/devices/hostEmulatorProcessStopper";
import { DeviceBootService } from "../../src/devices/deviceBootService";
import type { DeviceShutdownOptions } from "../../src/devices/deviceUtils";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeDeviceCreationGate } from "../fakes/FakeDeviceCreationGate";
import { FakeDeviceProvisioner } from "../fakes/FakeDeviceProvisioner";
import { FakeTimer } from "../fakes/FakeTimer";

for (const platform of ["android", "ios"] as const) {
  test(`${platform} ANR shutdown ${platform === "android" ? "uses" : "omits"} the timer process stopper`, async () => {
    const timer = new FakeTimer();
    const manager = new FakeDeviceManager();
    const failure = new Error("stop reached");
    let options: DeviceShutdownOptions | undefined;
    manager.killDevice = async (_device, supplied) => {
      options = supplied;
      throw failure;
    };
    manager.deviceImages = [{ platform: "android", name: "Pixel", isRunning: false }];
    const bootService = new DeviceBootService({
      deviceManager: manager,
      deviceMatcher: new FakeDeviceMatcher(),
      deviceCreationGate: new FakeDeviceCreationGate(),
      deviceProvisioner: new FakeDeviceProvisioner(),
      matchingStrategy: "LATEST",
      timer,
    });
    await expect(
      rebootAndroidAfterSystemUiAnr({
        boot: {
          device: { platform, name: "Unknown (emulator-5554)", deviceId: "emulator-5554" },
          sourceImage: { platform: "android", name: "Pixel", isRunning: true },
          source: "booted",
          provisioned: false,
        },
        args: { platform },
        bootService,
        deviceManager: manager,
        devicePool: undefined,
        totalDeadlineMs: 30_000,
        timer,
        signal: undefined,
        progress: undefined,
        recoveryAutolockClient: undefined,
        assertHolder: () => {},
        collectColdBootSettlement: () => {},
        releasePreservedSession: async () => {},
        operations: {
          deviceShutdownTimeoutMs: 30_000,
          runWithinShutdownDeadline: async (_device, _timer, _deadline, input) =>
            input.operation(new AbortController().signal, 30_000),
          waitForDeviceShutdown: async () => {},
          shouldClearIntentionalShutdownAfterFailure: () => false,
          cancelUnownedColdBoot: async () => {},
          isUnknownAndroidRuntimeName: () => false,
        },
      }),
    ).rejects.toBe(failure);
    if (platform === "android") {
      expect(options?.processStop?.stopper).toBe(getHostEmulatorProcessStopper(timer));
      expect(options?.processStop?.expectedAvdName).toBe("Pixel");
    } else {
      expect(options?.processStop).toBeUndefined();
    }
  });
}
