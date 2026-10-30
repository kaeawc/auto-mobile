import { describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice, Platform } from "../../src/models";
import {
  DEVICE_TRAITS_TIMEOUT_MS,
  enrich,
  resolveFormFactor,
  type BootedDeviceTraits,
} from "../../src/server/bootedDeviceTraits";
import type { DeviceTraits } from "../../src/utils/android-cmdline-tools/deviceTraits";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../../src/utils/logger";
import { isAutomotive, isWatch } from "../../src/utils/android-cmdline-tools/deviceTraits";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeDeviceTraits, androidDeviceTraits } from "../fakes/FakeDeviceTraits";
import { FakeTimer } from "../fakes/FakeTimer";

interface Entry {
  platform: Platform;
  deviceId: string;
  probeable: boolean;
  traits?: BootedDeviceTraits;
}

const entry = (platform: Platform, deviceId: string, probeable = true): Entry => ({
  platform,
  deviceId,
  probeable,
});

const target = (device: Entry): BootedDevice | null =>
  device.probeable ? { platform: device.platform, deviceId: device.deviceId, name: "x" } : null;

const options = (reader: FakeDeviceTraits | null, serviceStatusEnabled = false) => ({
  target,
  timer: new FakeTimer(),
  deps: { injectedDeviceTraits: reader },
  serviceStatusEnabled,
  adbFactory: new FakeAdbClientFactory(),
});

describe("bootedDeviceTraits.resolveFormFactor", () => {
  test("a stalled read warns with the timeout error and leaves the device unchanged", async () => {
    const reader = {
      read: () => new Promise<never>(() => {}),
    } satisfies DeviceTraits;
    const timer = new FakeTimer();
    const device: BootedDevice = {
      platform: "android",
      deviceId: "traits-timeout-device",
      name: "TV",
    };
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const adb = spyOn(defaultAdbClientFactory, "create").mockReturnValue(
      new FakeAdbClientFactory().create(),
    );
    try {
      const result = resolveFormFactor(device, timer, { injectedDeviceTraits: reader });
      timer.advanceTime(DEVICE_TRAITS_TIMEOUT_MS);

      expect(await result).toBe(device);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"), expect.any(Error));
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      adb.mockRestore();
      warn.mockRestore();
    }
  });

  test.each(["ios", "watchos"] as const)("%s never reads Android traits", async (platform) => {
    const device: BootedDevice = { platform, deviceId: "apple-traits-device", name: "Apple" };
    const reader = new FakeDeviceTraits(androidDeviceTraits({ formFactor: "tv" }));

    expect(await resolveFormFactor(device, new FakeTimer(), { injectedDeviceTraits: reader })).toBe(
      device,
    );
    expect(reader.reads).toHaveLength(0);
  });
});

describe("bootedDeviceTraits.enrich", () => {
  test("attaches manufacturer and brand to probeable Android entries only", async () => {
    const reader = new FakeDeviceTraits(
      androidDeviceTraits({ manufacturer: "Xiaomi", brand: "Redmi", model: "23090RA98G" }),
    );
    const devices = [
      entry("android", "emulator-5554"),
      entry("ios", "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"),
      entry("android", "emulator-5556", false),
    ];

    await enrich(devices, options(reader));

    expect(devices[0].traits).toEqual({
      manufacturer: "Xiaomi",
      brand: "Redmi",
      model: "23090RA98G",
      sdk: 35,
      abi: "arm64-v8a",
      formFactor: null,
    });
    expect(devices[1].traits).toBeUndefined();
    expect(devices[2].traits).toBeUndefined();
    expect(reader.reads.map((read) => read.deviceId)).toEqual(["emulator-5554"]);
  });

  test("carries an announced watch, automotive or tv form factor and leaves handhelds null", async () => {
    const reader = new FakeDeviceTraits(androidDeviceTraits());
    reader.setTraitsFor("emulator-5554", androidDeviceTraits({ formFactor: "automotive" }));
    reader.setTraitsFor("emulator-5556", androidDeviceTraits({ formFactor: "watch" }));
    reader.setTraitsFor("emulator-5560", androidDeviceTraits({ formFactor: "tv" }));
    const devices = [
      entry("android", "emulator-5554"),
      entry("android", "emulator-5556"),
      entry("android", "emulator-5558"),
      entry("android", "emulator-5560"),
    ];

    await enrich(devices, options(reader));

    expect(devices.map((device) => device.traits?.formFactor)).toEqual([
      "automotive",
      "watch",
      null,
      "tv",
    ]);
    expect(devices.map((device) => isAutomotive(device.traits))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(devices.map((device) => isWatch(device.traits))).toEqual([false, true, false, false]);
  });

  test("a failed read leaves that entry without traits and keeps the others", async () => {
    const reader = new FakeDeviceTraits();
    reader.setTraitsFor("emulator-5554", new Error("device offline"));
    const devices = [entry("android", "emulator-5554"), entry("android", "emulator-5556")];

    await enrich(devices, options(reader));

    expect(devices[0].traits).toBeUndefined();
    expect(devices[1].traits?.manufacturer).toBe("Google");
  });

  test("does nothing when production probes are off and no reader is injected", async () => {
    const devices = [entry("android", "emulator-5554")];

    await enrich(devices, options(null, false));

    expect(devices[0].traits).toBeUndefined();
  });
});
