import { assertExactAndroidImageDiscovery } from "../../src/devices/androidBootIdentity";
import { findExactProvisionedBootedDevice } from "../../src/features/deviceLifecycle/provisioning/provisioning";
import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { BootedDevice } from "../../src/models";
import {
  MultiPlatformDeviceManager,
  assertAndroidImageRunningStateKnown,
} from "../../src/devices/deviceUtils";
import { DefaultAndroidDeviceInventoryScanner } from "../../src/utils/android-cmdline-tools/AndroidDeviceInventoryScanner";
import { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { parseAdbDevicesList } from "../../src/utils/android-cmdline-tools/parseAdbDevicesList";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import { createFakeAndroidEmulator } from "../fakes/FakeAndroidEmulator";
import { DeviceManagerBindingInventory } from "../../src/daemon/sessionBroker/provisioning/DeviceManagerBindingInventory";
import { logger } from "../../src/utils/logger";

const listing = readFileSync(
  new URL("../fixtures/android-adb/adb-devices-l.txt", import.meta.url),
  "utf8",
);
const displays = readFileSync(
  new URL("../fixtures/android-display/phone-displays.txt", import.meta.url),
  "utf8",
);

function harness() {
  const adb = new FakeAdbClient();
  const devices: BootedDevice[] = parseAdbDevicesList(listing).map(({ deviceId }) => ({
    deviceId,
    name: deviceId,
    platform: "android",
  }));
  // Serial identity is irrelevant to the captured adb row's metadata.
  devices[1] = { ...devices[1]!, deviceId: "emulator-5610", name: "emulator-5610" };
  adb.setDevices(devices);
  adb.setCommandResult("shell dumpsys display", displays);
  const factory = new FakeAdbClientFactory(adb);
  const timer = new FakeTimer();
  const names: string[] = [];
  const nameBudgets: number[] = [];
  const scanner = new DefaultAndroidDeviceInventoryScanner({
    timer: () => timer,
    adbFactory: () => factory,
    observationSequence: () => ({ next: () => 1 }),
    avdConfigReader: () => ({ readConfig: async () => null }),
    getRunningAvdName: async ({ deviceId }, timeoutMs) => {
      nameBudgets.push(timeoutMs);
      names.push(deviceId);
      return deviceId === "emulator-5610"
        ? { name: "", nameProbeTimedOut: true }
        : { name: "owned" };
    },
    isUnknownEmulatorName: (name, serial) => name === `Unknown (${serial})`,
    unknownEmulatorName: (serial) => `Unknown (${serial})`,
    throwIfAborted: (signal) => signal?.throwIfAborted(),
  });
  const emulator = createFakeAndroidEmulator({
    listAvds: async () => [{ name: "broker", platform: "android", isRunning: false }],
    getBootedDevicesChecked: async (only, options, signal) =>
      (await scanner.getBootedDevicesWithDiagnostics(only, options, signal)).devices,
  });
  const manager = new MultiPlatformDeviceManager(adb, null, emulator, undefined, timer);
  return { scanner, factory, names, manager, adb, timer, nameBudgets };
}

describe("foreign Android inventory", () => {
  test("skips all foreign emulator probes while enriching the owned emulator", async () => {
    const { scanner, factory, names, adb } = harness();
    const result = await scanner.getBootedDevicesWithDiagnostics(false, {
      foreignSerials: new Set(["emulator-5610"]),
    });
    expect(names).toEqual(["emulator-5554"]);
    expect(factory.getCalls().filter(({ device }) => device?.deviceId === "emulator-5610")).toEqual(
      [],
    );
    expect(
      adb.getInteractionLog().some(({ text }) => text === "shell getprop ro.product.model"),
    ).toBe(true);
    expect(adb.getInteractionLog().some(({ text }) => text === "shell dumpsys display")).toBe(true);
    expect(result.devices[1]).toMatchObject({
      name: "Unknown (emulator-5610)",
      foreignOwned: true,
    });
    expect(result.devices[1]?.nameProbeTimedOut).toBeUndefined();
  });

  test("foreign unresolved identity cannot make the broker image unsafe to cold boot", async () => {
    const { manager, names } = harness();
    manager.withForeignAndroidSerialSource({
      foreignSerials: async () => new Set(["emulator-5610"]),
    });
    const images = await manager.listDeviceImages("android");
    expect(images[0]?.isRunning).toBe(false);
    expect(images[0]?.isRunningStateKnown).toBeUndefined();
    expect(() => assertAndroidImageRunningStateKnown(images[0]!)).not.toThrow();
    expect(names).toEqual(["emulator-5554"]);
  });

  test("broker inventory listing always applies the ownership-aware image overlay", async () => {
    const { manager, names, adb } = harness();
    const list = spyOn(adb, "getBootedAndroidDevices");
    try {
      manager.withForeignAndroidSerialSource({
        foreignSerials: async () => new Set(["emulator-5610"]),
      });
      const inventory = await new DeviceManagerBindingInventory(manager).list("android", {});
      expect(inventory.complete).toBe(true);
      expect(inventory.devices[0]?.isRunningStateKnown).toBeUndefined();
      expect(names).toEqual(["emulator-5554"]);
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      list.mockRestore();
    }
  });

  test("unknown ownership retains the unresolved identity guard", async () => {
    const { manager } = harness();
    manager.withForeignAndroidSerialSource({ foreignSerials: async () => new Set() });
    const images = await manager.listDeviceImages("android");
    expect(images[0]?.isRunningStateKnown).toBe(false);
    expect(() => assertAndroidImageRunningStateKnown(images[0]!)).toThrow();
  });

  test("source failure warns and enriches every serial", async () => {
    const { manager, names } = harness();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      manager.withForeignAndroidSerialSource({
        foreignSerials: async () => {
          throw new Error("ownership failed");
        },
      });
      await manager.getBootedDevicesDetailed("android", { skipForeignEnrichment: true });
      expect(names).toEqual(["emulator-5554", "emulator-5610"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("ownership"), expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  test("native readiness scans use the manager ownership source", async () => {
    const { scanner, adb, names } = harness();
    const client = new AndroidEmulatorClient({
      inventory: scanner,
      timer: new FakeTimer(),
      adbFactory: new FakeAdbClientFactory(adb),
    });
    new MultiPlatformDeviceManager(adb, null, client).withForeignAndroidSerialSource({
      foreignSerials: async () => new Set(["emulator-5610"]),
    });
    const result = await client.getBootedDevicesChecked(false, { readinessOnly: true });
    expect(names).toEqual(["emulator-5554"]);
    expect(result[1]?.foreignOwned).toBe(true);
  });

  test("foreign physical serials also receive no device-scoped client", async () => {
    const { scanner, factory } = harness();
    const result = await scanner.getBootedDevicesWithDiagnostics(false, {
      devices: [{ deviceId: "physical", name: "physical", platform: "android" }],
      foreignSerials: new Set(["physical"]),
    });
    expect(factory.getCalls().filter(({ device }) => device !== null)).toEqual([]);
    expect(result.devices[0]).toMatchObject({ name: "physical", foreignOwned: true });
  });

  test("caller cancellation bounds an ownership source that never settles", async () => {
    const { manager } = harness();
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<ReadonlySet<string>>();
    const controller = new AbortController();
    manager.withForeignAndroidSerialSource({
      foreignSerials: () => {
        started.resolve();
        return pending.promise;
      },
    });
    const result = manager.getBootedDevicesDetailed("android", {
      skipForeignEnrichment: true,
      signal: controller.signal,
    });
    await started.promise;
    controller.abort(new Error("request expired"));
    await expect(result).rejects.toThrow("request expired");
  });

  test("ownership lookup cannot extend an exhausted scan budget", async () => {
    const { scanner, names, timer } = harness();
    const result = scanner.getBootedDevicesWithDiagnostics(false, {
      timeoutMs: 20,
      readinessOnly: true,
      resolveForeignSerials: async () => {
        timer.advanceTime(20);
        return new Set(["emulator-5610"]);
      },
    });
    await result;
    expect(timer.now()).toBe(20);
    expect(names).toEqual([]);
  });

  test("owned emulators retain the unspent name-probe budget after ownership lookup", async () => {
    const { scanner, names, nameBudgets, timer } = harness();
    await scanner.getBootedDevicesWithDiagnostics(false, {
      timeoutMs: 20,
      readinessOnly: true,
      resolveForeignSerials: async () => {
        timer.advanceTime(5);
        return new Set(["emulator-5610"]);
      },
    });
    expect(names).toEqual(["emulator-5554"]);
    expect(nameBudgets).toEqual([15]);
  });

  test("scan deadline aborts an ownership source that never settles", async () => {
    const { scanner, timer } = harness();
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<ReadonlySet<string>>();
    let lookupSignal: AbortSignal | undefined;
    const result = scanner.getBootedDevicesWithDiagnostics(false, {
      timeoutMs: 20,
      readinessOnly: true,
      resolveForeignSerials: (_serials, signal) => {
        lookupSignal = signal;
        started.resolve();
        return pending.promise;
      },
    });
    void result.catch(() => {});
    await started.promise;
    expect(lookupSignal).toBeDefined();
    timer.advanceTime(20);
    await expect(result).rejects.toThrow(/ownership lookup/);
    expect(lookupSignal?.aborted).toBe(true);
  });

  test("provisioning never adopts a foreign placeholder by its stale image serial", () => {
    const foreign: BootedDevice = {
      deviceId: "emulator-5610",
      name: "Unknown (emulator-5610)",
      platform: "android",
      foreignOwned: true,
    };
    expect(
      findExactProvisionedBootedDevice("android", [foreign], {
        name: "owned",
        deviceId: foreign.deviceId,
      }),
    ).toBeUndefined();
  });

  test("exact image discovery ignores foreign serial occupancy", () => {
    const foreign: BootedDevice = {
      deviceId: "emulator-5610",
      name: "Unknown (emulator-5610)",
      platform: "android",
      foreignOwned: true,
    };
    expect(() =>
      assertExactAndroidImageDiscovery(
        { platform: "android", name: "owned", deviceId: foreign.deviceId, isRunning: false },
        [foreign],
        true,
        false,
      ),
    ).not.toThrow();
  });

  test("ordinary booted discovery keeps full enrichment", async () => {
    const { manager, names } = harness();
    manager.withForeignAndroidSerialSource({
      foreignSerials: async () => new Set(["emulator-5610"]),
    });
    await manager.getBootedDevicesDetailed("android");
    expect(names).toEqual(["emulator-5554", "emulator-5610"]);
  });
});
