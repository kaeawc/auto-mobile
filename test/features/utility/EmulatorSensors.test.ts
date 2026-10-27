import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AdbEmulatorSensorConsole,
  EMULATOR_SENSOR_NAMES,
  emulatorSensorValueError,
  formatEmulatorSensorValue,
  parseEmulatorSensorReadback,
  readEmulatorSensors,
  type EmulatorSensorConsole,
} from "../../../src/features/utility/EmulatorSensors";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const FIXTURES = join(import.meta.dir, "../../fixtures/android-emulator-sensors");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };

describe("emulatorSensorValueError", () => {
  test.each([
    ["acceleration", [0, 9.8, 0]],
    ["orientation", [360, -180, 90]],
    ["proximity", [0]],
    ["light", [200_000]],
    ["temperature", [-273.15]],
    ["humidity", [100]],
  ] as const)("accepts %s %p", (sensor, value) => {
    expect(emulatorSensorValueError(sensor, value)).toBeUndefined();
  });

  test("rejects the wrong arity, naming the components", () => {
    expect(emulatorSensorValueError("light", [1, 2])).toBe(
      "light takes 1 value (illuminance), got 2.",
    );
    expect(emulatorSensorValueError("gyroscope", [1])).toBe(
      "gyroscope takes 3 values (x, y, z), got 1.",
    );
  });

  test.each([
    ["proximity", [-1], "proximity distance must be a finite number from 0 to 100 cm, got -1."],
    [
      "orientation",
      [0, 0, 91],
      "orientation roll must be a finite number from -90 to 90 degrees, got 91.",
    ],
    [
      "humidity",
      [Number.NaN],
      "humidity relative must be a finite number from 0 to 100 %, got NaN.",
    ],
  ] as const)("rejects an out-of-range %s", (sensor, value, message) => {
    expect(emulatorSensorValueError(sensor, value)).toBe(message);
  });
});

describe("formatEmulatorSensorValue", () => {
  test("joins with colons, rounds to 6 decimals and never emits exponents or -0", () => {
    expect(formatEmulatorSensorValue([0, 9.776224, -0])).toBe("0:9.776224:0");
    expect(formatEmulatorSensorValue([1e-7])).toBe("0");
    expect(formatEmulatorSensorValue([0.1234567])).toBe("0.123457");
  });
});

describe("parseEmulatorSensorReadback (hand-reconstructed console fixtures)", () => {
  test.each([
    ["sensor-get-acceleration.txt", "acceleration", [0, 9.77622, 0]],
    ["sensor-get-magnetic-field.txt", "magnetic-field", [0, 5.9, -48.4]],
    ["sensor-get-orientation.txt", "orientation", [0, 0, 0]],
    ["sensor-get-light.txt", "light", [0]],
    ["sensor-get-proximity.txt", "proximity", [1]],
    ["sensor-get-pressure.txt", "pressure", [1013.25]],
  ] as const)("%s", (file, sensor, value) => {
    expect(parseEmulatorSensorReadback(fixture(file), sensor)).toEqual([...value]);
  });

  test("accepts CRLF and rejects ambiguous or mismatched output", () => {
    expect(parseEmulatorSensorReadback("light = 12.5\r\nOK\r\n", "light")).toEqual([12.5]);
    expect(parseEmulatorSensorReadback("light = 1:2\nOK", "light")).toBeUndefined();
    expect(parseEmulatorSensorReadback("light = 1\nlight = 2\nOK", "light")).toBeUndefined();
    expect(parseEmulatorSensorReadback("proximity = 1\nOK", "light")).toBeUndefined();
    expect(parseEmulatorSensorReadback("light = NaN\nOK", "light")).toBeUndefined();
  });
});

describe("AdbEmulatorSensorConsole", () => {
  test("reads, writes and reports console refusals without throwing", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "emu sensor get light",
      createExecResult(fixture("sensor-get-light.txt"), ""),
    );
    adb.setCommandResponse(
      "emu sensor get humidity",
      createExecResult(fixture("sensor-get-humidity-disabled.txt"), ""),
    );
    adb.setCommandResponse(
      "emu sensor set light",
      createExecResult(fixture("sensor-set-ok.txt"), ""),
    );
    adb.setCommandResponse(
      "emu sensor set acceleration",
      createExecResult(fixture("sensor-set-usage-ko.txt"), ""),
    );
    const sensorConsole = new AdbEmulatorSensorConsole(adb);

    expect(await sensorConsole.read("light")).toEqual({ ok: true, value: [0] });
    expect(await sensorConsole.read("humidity")).toEqual({
      ok: false,
      reason: "KO: 'humidity' is disabled.",
    });
    expect(await sensorConsole.write("light", [500])).toEqual({ ok: true });
    expect((await sensorConsole.write("acceleration", [1, 2, 3])).ok).toBe(false);
    expect(adb.getExecutedCommands()).toEqual([
      "emu sensor get light",
      "emu sensor get humidity",
      "emu sensor set light 500",
      "emu sensor set acceleration 1:2:3",
    ]);
    expect(adb.getCommandCalls().every((call) => call.noRetry === true)).toBe(true);
  });
});

/** Answers each sensor from a table; a missing sensor is a console refusal. */
function tableConsole(values: Partial<Record<string, number[]>>): EmulatorSensorConsole {
  return {
    read: async (sensor) => {
      const value = values[sensor];
      return value ? { ok: true, value } : { ok: false, reason: `KO: '${sensor}' is disabled.` };
    },
    write: async () => ({ ok: true }),
  };
}

describe("readEmulatorSensors", () => {
  test("reports every readable sensor and lists the refused ones as unavailable", async () => {
    const state = await readEmulatorSensors(emulator, () =>
      tableConsole({ acceleration: [0, 9.77622, 0], light: [40], proximity: [1] }),
    );
    expect(state.supported).toBe(true);
    expect(state.sensors).toEqual([
      { name: "acceleration", value: [0, 9.77622, 0] },
      { name: "proximity", value: [1] },
      { name: "light", value: [40] },
    ]);
    expect(state.unavailable?.map((entry) => entry.name)).toEqual(
      EMULATOR_SENSOR_NAMES.filter(
        (name) => !["acceleration", "proximity", "light"].includes(name),
      ),
    );
  });

  test("is unsupported on a physical device and iOS without touching adb", async () => {
    const consoleFor = () => {
      throw new Error("no console expected");
    };
    for (const device of [
      { name: "phone", platform: "android", deviceId: "R58M123ABC" },
      { name: "sim", platform: "ios", deviceId: "6A1B2C3D-0000-0000-0000-000000000000" },
    ] as const) {
      const state = await readEmulatorSensors(device, consoleFor);
      expect(state.supported).toBe(false);
      expect(state.error).toContain("only available on an Android emulator");
    }
  });

  test("an adb failure ends the read with an error", async () => {
    const state = await readEmulatorSensors(emulator, () => ({
      read: async () => {
        throw new Error("device offline");
      },
      write: async () => ({ ok: true }),
    }));
    expect(state).toEqual({
      supported: true,
      method: "android_emulator_console",
      error: "Failed to read emulator sensors: device offline",
    });
  });
});
