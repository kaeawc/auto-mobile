import { describe, expect, test } from "bun:test";
import type { BootedDevice, Platform } from "../../src/models";
import { enrich, type BootedDeviceTraits } from "../../src/server/bootedDeviceTraits";
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

  test("carries an announced watch or automotive form factor and leaves handhelds null", async () => {
    const reader = new FakeDeviceTraits(androidDeviceTraits());
    reader.setTraitsFor("emulator-5554", androidDeviceTraits({ formFactor: "automotive" }));
    reader.setTraitsFor("emulator-5556", androidDeviceTraits({ formFactor: "watch" }));
    const devices = [
      entry("android", "emulator-5554"),
      entry("android", "emulator-5556"),
      entry("android", "emulator-5558"),
    ];

    await enrich(devices, options(reader));

    expect(devices.map((device) => device.traits?.formFactor)).toEqual([
      "automotive",
      "watch",
      null,
    ]);
    expect(devices.map((device) => isAutomotive(device.traits))).toEqual([true, false, false]);
    expect(devices.map((device) => isWatch(device.traits))).toEqual([false, true, false]);
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
