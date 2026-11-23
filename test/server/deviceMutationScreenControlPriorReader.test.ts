import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { ScreenControlMutationPriorReader } from "../../src/server/deviceMutationScreenControlPriorReader";

const simulator: BootedDevice = {
  name: "iPhone 17 Pro",
  platform: "ios",
  deviceId: "994D7AD5-32E6-43AA-BB3E-CE61A8D277A1",
};

function reader(island: boolean | null | Error, lit: boolean | Error) {
  const devices: string[] = [];
  const subject = new ScreenControlMutationPriorReader((device) => {
    devices.push(device.deviceId);
    return {
      readIslandSuppressedDefault: async () => {
        if (island instanceof Error) {
          throw island;
        }
        return island;
      },
      readBacklightOrThrow: async () => {
        if (lit instanceof Error) {
          throw lit;
        }
        return lit;
      },
    };
  });
  return { subject, devices };
}

const ROWS = [
  { kind: "device-setting", key: "dynamicIsland" },
  { kind: "device-setting", key: "backlight" },
  { kind: "device-setting", key: "nightMode" },
];

describe("ScreenControlMutationPriorReader (#19018)", () => {
  test("reads the island default and backlight; other rows stay unobservable", async () => {
    const { subject } = reader(true, false);

    expect(await subject.read(simulator, ROWS)).toEqual([
      { state: "present", value: true },
      { state: "present", value: false },
      { state: "unobservable" },
    ]);
  });

  test("an unset island default is an absent prior", async () => {
    const { subject } = reader(null, true);

    expect((await subject.read(simulator, ROWS.slice(0, 1)))[0]).toEqual({ state: "absent" });
  });

  test("a failed read is unobservable", async () => {
    const { subject } = reader(new Error("simctl failed"), new Error("notifyutil failed"));

    expect(await subject.read(simulator, ROWS.slice(0, 2))).toEqual([
      { state: "unobservable" },
      { state: "unobservable" },
    ]);
  });

  test("physical iOS and Android devices are never read", async () => {
    const { subject, devices } = reader(true, true);
    const physical: BootedDevice = { ...simulator, deviceId: "00008130-001234567890ABCD" };
    const android: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };

    expect(await subject.read(physical, ROWS.slice(0, 1))).toEqual([{ state: "unobservable" }]);
    expect(await subject.read(android, ROWS.slice(0, 1))).toEqual([{ state: "unobservable" }]);
    expect(devices).toEqual([]);
  });
});
