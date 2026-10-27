import { beforeEach, describe, expect, test } from "bun:test";
import { setEmulatorSensor } from "../../../src/features/utility/SetSensor";
import { EmulatorSensorRestoreRegistry } from "../../../src/features/utility/EmulatorSensorRestore";
import { EmulatorSensorUnsupportedError } from "../../../src/features/utility/EmulatorSensorUnsupportedError";
import { ActionableError, type BootedDevice } from "../../../src/models";
import { FakeEmulatorSensorConsole } from "../../fakes/FakeEmulatorSensorConsole";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };

describe("setEmulatorSensor (#14114)", () => {
  let sensors: FakeEmulatorSensorConsole;
  let registry: EmulatorSensorRestoreRegistry;

  beforeEach(() => {
    sensors = new FakeEmulatorSensorConsole({ light: [0], proximity: [1] });
    registry = new EmulatorSensorRestoreRegistry();
  });

  const set = (input: Parameters<typeof setEmulatorSensor>[1], owner?: string) =>
    setEmulatorSensor(emulator, input, { console: sensors, registry, owner });

  test.each([
    { name: "phone", platform: "android", deviceId: "R58M123ABC" },
    { name: "sim", platform: "ios", deviceId: "6A1B2C3D-0000-0000-0000-000000000000" },
  ] as const)("refuses $platform $deviceId with a typed, actionable error", async (device) => {
    const call = setEmulatorSensor(
      device,
      { sensor: "light", value: [5] },
      { console: sensors, registry },
    );
    await expect(call).rejects.toBeInstanceOf(EmulatorSensorUnsupportedError);
    await expect(call).rejects.toThrow("Target an Android emulator");
    expect(sensors.calls).toEqual([]);
  });

  test("rejects invalid input before any console call", async () => {
    await expect(set({ sensor: "light", value: [1, 2] })).rejects.toThrow("light takes 1 value");
    await expect(set({ sensor: "proximity", value: [-5] })).rejects.toThrow("from 0 to 100 cm");
    await expect(set({ sensor: "light" })).rejects.toThrow("exactly one of value or reset");
    await expect(set({ sensor: "light", value: [1], reset: true })).rejects.toThrow(
      "exactly one of value or reset",
    );
    expect(sensors.calls).toEqual([]);
  });

  test("sets a sensor and returns applied, previous and a restore receipt", async () => {
    const result = await set({ sensor: "light", value: [500.1234567] }, "session-1");
    expect(sensors.calls).toEqual(["get light", "set light 500.123457"]);
    expect(result).toEqual({
      deviceId: "emulator-5554",
      sensor: "light",
      previous: [0],
      applied: [500.123457],
      changed: true,
      reset: false,
      restore: { value: [0], onSessionRelease: true },
      message: "Set light to 500.123457 (was 0)",
    });
  });

  test("keeps the first original across later sets, and reset restores it", async () => {
    await set({ sensor: "light", value: [500] });
    const second = await set({ sensor: "light", value: [20] });
    expect(second.previous).toEqual([500]);
    expect(second.restore).toEqual({ value: [0], onSessionRelease: false });

    const reset = await set({ sensor: "light", reset: true });
    expect(reset).toMatchObject({ applied: [0], previous: [20], changed: true, reset: true });
    expect(reset.restore).toBeUndefined();
    expect(sensors.values.get("light")).toEqual([0]);
    expect(registry.original(emulator.deviceId, "light")).toBeUndefined();
  });

  test("reset with nothing recorded reads but does not write", async () => {
    const result = await set({ sensor: "proximity", reset: true });
    expect(sensors.calls).toEqual(["get proximity"]);
    expect(result).toMatchObject({ applied: [1], previous: [1], changed: false, reset: true });
    expect(result.message).toContain("No setSensor change to proximity is recorded");
  });

  test("setting the original value again drops the slot", async () => {
    await set({ sensor: "proximity", value: [0] }, "session-1");
    const back = await set({ sensor: "proximity", value: [1] }, "session-1");
    expect(back.restore).toBeUndefined();
    expect(registry.takeOwnedBy(emulator.deviceId, "session-1")).toBeUndefined();
  });

  test("a console refusal changes nothing and drops the slot it recorded", async () => {
    sensors.refuseWrites.set("light", "KO: 'light' is disabled.");
    const call = set({ sensor: "light", value: [5] }, "session-1");
    await expect(call).rejects.toBeInstanceOf(ActionableError);
    await expect(call).rejects.toThrow("refused 'sensor set light 5'");
    expect(registry.original(emulator.deviceId, "light")).toBeUndefined();
  });

  test("an adb failure on write keeps the slot, since the write may have landed", async () => {
    sensors.failWrites.set("light", new Error("adb timed out"));
    await expect(set({ sensor: "light", value: [5] }, "session-1")).rejects.toThrow(
      "Failed to send 'sensor set light 5' to emulator-5554: adb timed out",
    );
    expect(registry.original(emulator.deviceId, "light")).toEqual([0]);
  });

  test("an unreadable sensor is never written", async () => {
    await expect(set({ sensor: "humidity", value: [40] })).rejects.toThrow(
      "could not read the humidity sensor",
    );
    sensors.failReads.set("light", new Error("device offline"));
    await expect(set({ sensor: "light", value: [40] })).rejects.toThrow("device offline");
    expect(sensors.calls).toEqual(["get humidity", "get light"]);
  });
});
