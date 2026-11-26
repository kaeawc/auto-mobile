import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

describe("DefaultAndroidDeviceInventoryScanner runtime facts (#18988)", () => {
  const fixture = (path: string): string =>
    readFileSync(new URL(`../../fixtures/${path}.txt`, import.meta.url), "utf8");
  let adb: FakeAdbClient;
  let scanner: DefaultAndroidDeviceInventoryScanner;
  const emulator = (): BootedDevice => ({
    deviceId: "emulator-5554",
    name: "emulator-5554",
    platform: "android",
  });

  beforeEach(() => {
    resetAndroidInventoryEnrichmentCache();
    adb = new FakeAdbClient();
    adb.setCommandResult("shell getprop ro.build.version.sdk", "24\n");
    adb.setCommandResult("shell getprop ro.build.version.release", "7.0\n");
    adb.setCommandResult("shell wm size", fixture("android-display-geometry/wm-size-physical"));
    adb.setCommandResult(
      "shell wm density",
      fixture("android-display-config/density-physical-420"),
    );
    const timer = new FakeTimer();
    scanner = new DefaultAndroidDeviceInventoryScanner({
      timer: () => timer,
      adbFactory: () => new FakeAdbClientFactory(adb),
      observationSequence: () => ({ next: () => 1 }),
      // No avdmanager / unreadable AVD config: nothing comes from the image.
      avdConfigReader: () => ({ readConfig: async () => null }),
      getRunningAvdName: async () => ({ name: "hive24" }),
      isUnknownEmulatorName: (name, deviceId) => name === `Unknown (${deviceId})`,
      unknownEmulatorName: (deviceId) => `Unknown (${deviceId})`,
      throwIfAborted: () => {},
    });
  });

  test("an emulator whose AVD cannot be resolved still reports its release and display", async () => {
    const scan = await scanner.getBootedDevicesWithDiagnostics(false, {
      devices: [emulator()],
      timeoutMs: 5_000,
    });

    expect(scan.devices[0]).toMatchObject({
      name: "hive24",
      apiLevel: 24,
      osVersion: "7.0",
      screenWidth: 1080,
      screenHeight: 2400,
      screenDensity: 420,
    });
  });

  test("a handset reports its release and display too", async () => {
    const scan = await scanner.getBootedDevicesWithDiagnostics(false, {
      devices: [physicalPhone()],
      timeoutMs: 5_000,
    });

    expect(scan.devices[0]).toMatchObject({ apiLevel: 24, osVersion: "7.0", screenWidth: 1080 });
  });

  test("facts are read once per device, then served from the cache", async () => {
    await scanner.getBootedDevicesWithDiagnostics(false, {
      devices: [emulator()],
      timeoutMs: 5_000,
    });
    const second = await scanner.getBootedDevicesWithDiagnostics(false, {
      devices: [emulator()],
      timeoutMs: 5_000,
    });

    expect(second.devices[0]).toMatchObject({ apiLevel: 24, screenDensity: 420 });
    expect(adb.getInteractionLog().filter((entry) => entry.text === "shell wm size")).toHaveLength(
      1,
    );
  });

  test("readiness-only scans do not read runtime facts", async () => {
    const scan = await scanner.getBootedDevicesWithDiagnostics(false, {
      devices: [emulator()],
      readinessOnly: true,
      timeoutMs: 5_000,
    });

    expect(scan.devices[0].apiLevel).toBeUndefined();
    expect(adb.getInteractionLog().map((entry) => entry.text)).not.toContain(
      "shell getprop ro.build.version.sdk",
    );
  });
});
