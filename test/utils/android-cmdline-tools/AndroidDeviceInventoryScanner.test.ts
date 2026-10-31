import { beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  DefaultAndroidDeviceInventoryScanner,
  resetAndroidInventoryEnrichmentCache,
  type AndroidDeviceInventoryDeps,
} from "../../../src/utils/android-cmdline-tools/AndroidDeviceInventoryScanner";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { withAndroidTransportId } from "../../../src/utils/androidSerial";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { ExecutionTracker } from "../../../src/daemon/executionTracker";
import { AdmittingAdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { runWithDeviceExecutionBinding } from "../../../src/utils/deviceExecutionBinding";

const physicalPhone = (): BootedDevice => ({
  deviceId: "R58M123ABC",
  name: "R58M123ABC",
  platform: "android",
});

describe("inventory execution binding", () => {
  for (const enrichment of [
    {},
    { coalesceInventoryEnrichment: true },
    { memoizeReadAvdNames: true },
  ]) {
    test(`fleet reads preserve admission without binding unrelated devices ${JSON.stringify(enrichment)}`, async () => {
      const timer = new FakeTimer();
      const tracker = new ExecutionTracker(timer, new FakeIdGenerator(["provisioning"]));
      const execution = tracker.startExecution("provisionDevice");
      const unrelated: BootedDevice = withAndroidTransportId(
        {
          deviceId: "emulator-5556",
          name: "Other",
          platform: "android",
          observedAt: 1,
        },
        "1",
      );
      const target: BootedDevice = withAndroidTransportId(
        {
          deviceId: "emulator-5558",
          name: "Target",
          platform: "android",
          observedAt: 2,
        },
        "2",
      );
      const adb = new FakeAdbClient();
      adb.setDevices([unrelated, target, physicalPhone()]);
      adb.setCommandResult("shell getprop ro.product.model", "Pixel 9\n");
      adb.setCommandResult("shell getprop ro.product.cpu.abi", "arm64-v8a\n");
      const delegate = new FakeAdbClientFactory(adb);
      const admitted: string[] = [];
      const factory = new AdmittingAdbClientFactory(delegate, {
        admissionGate: {
          assertDeviceActionable: (id) => {
            admitted.push(id);
          },
        },
      });
      const scanner = new DefaultAndroidDeviceInventoryScanner({
        timer: () => timer,
        adbFactory: () => factory,
        observationSequence: () => ({ next: () => 1 }),
        avdConfigReader: () => ({ readConfig: async () => null }),
        getRunningAvdName: async (device) => {
          await factory.create(device).executeCommand("emu avd name");
          return { name: device.name };
        },
        isUnknownEmulatorName: (name, id) => name === `Unknown (${id})`,
        unknownEmulatorName: (id) => `Unknown (${id})`,
        throwIfAborted: (signal) => signal?.throwIfAborted(),
      });
      try {
        await runWithDeviceExecutionBinding(
          {
            bindDeviceExecution: (id) => tracker.bindDeviceExecution(execution.id, id),
          },
          async () => {
            const fleet = await scanner.getBootedDevicesWithDiagnostics(false, enrichment);
            expect(fleet.devices).toHaveLength(3);
            expect(admitted).toContain(unrelated.deviceId);
            expect(admitted).toContain(physicalPhone().deviceId);
            expect(tracker.getActiveDeviceExecutionCount(unrelated.deviceId)).toBe(0);
            expect(tracker.getActiveDeviceExecutionCount(target.deviceId)).toBe(0);
            expect(tracker.getActiveDeviceExecutionCount(physicalPhone().deviceId)).toBe(0);

            // An explicit scan still binds its target, even after fleet caches were populated.
            const selected = await scanner.getBootedDevicesWithDiagnostics(true, {
              targetDeviceId: target.deviceId,
            });
            expect(selected.devices.map((device) => device.deviceId)).toEqual([target.deviceId]);
            expect(tracker.getActiveDeviceExecutionCount(target.deviceId)).toBe(1);
          },
        );
        expect(
          await tracker.cancelDeviceExecutions(
            unrelated.deviceId,
            `device-disconnected:${unrelated.deviceId}`,
          ),
        ).toBe(0);
        expect(execution.abortController.signal.aborted).toBe(false);
        expect(
          await tracker.cancelDeviceExecutions(
            target.deviceId,
            `device-disconnected:${target.deviceId}`,
          ),
        ).toBe(1);
        expect(execution.abortController.signal.aborted).toBe(true);
      } finally {
        tracker.endExecution(execution.id);
      }
    });
  }
});

describe("DefaultAndroidDeviceInventoryScanner physical devices", () => {
  let adb: FakeAdbClient;
  let scanner: DefaultAndroidDeviceInventoryScanner;

  beforeEach(() => {
    resetAndroidInventoryEnrichmentCache();
    adb = new FakeAdbClient();
    adb.setCommandResult("shell getprop ro.product.model", "Pixel 9\n");
    adb.setCommandResult("shell getprop ro.product.cpu.abi", "arm64-v8a\n");
    const timer = new FakeTimer();
    const deps: AndroidDeviceInventoryDeps = {
      timer: () => timer,
      adbFactory: () => new FakeAdbClientFactory(adb),
      observationSequence: () => ({ next: () => 1 }),
      avdConfigReader: () => ({ readConfig: async () => null }),
      getRunningAvdName: async () => ({ name: "" }),
      isUnknownEmulatorName: (name, deviceId) => name === `Unknown (${deviceId})`,
      unknownEmulatorName: (deviceId) => `Unknown (${deviceId})`,
      throwIfAborted: () => {},
    };
    scanner = new DefaultAndroidDeviceInventoryScanner(deps);
  });

  test("describes a handset with its model and CPU architecture", async () => {
    const scan = await scanner.getBootedDevicesWithDiagnostics(false, {
      devices: [physicalPhone()],
      readinessOnly: true,
      timeoutMs: 5_000,
    });

    expect(scan.devices).toHaveLength(1);
    expect(scan.devices[0]).toMatchObject({
      deviceId: "R58M123ABC",
      model: "Pixel 9",
      architecture: "arm64-v8a",
    });
  });

  test("a serial-only scan never asks the handset for metadata", async () => {
    const scan = await scanner.getBootedDevicesWithDiagnostics(false, {
      devices: [physicalPhone()],
      readinessOnly: true,
      skipNameEnrichment: true,
      timeoutMs: 5_000,
    });

    expect(scan.devices.map((device) => device.deviceId)).toEqual(["R58M123ABC"]);
    expect(scan.devices[0].model).toBeUndefined();
    expect(adb.getInteractionLog()).toEqual([]);
  });
});
