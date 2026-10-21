import { describe, expect, test } from "bun:test";
import {
  buildGsmSignalCommand,
  buildNetworkDelayCommand,
  buildNetworkSpeedCommand,
  buildPowerStatusCommand,
  buildSensorSetCommand,
  parseSensorGetOutput,
  type ConsolePowerStatus,
} from "../../../src/utils/android-cmdline-tools/emulatorConsoleCommands";

describe("emulatorConsoleCommands (#14057)", () => {
  test("enumerated values outside the console's vocabulary are rejected with the allowed list", () => {
    // A value arriving from untyped JSON must not reach the wire.
    const untyped = "charging; quit" as ConsolePowerStatus;
    expect(() => buildPowerStatusCommand(untyped)).toThrow(
      /Expected one of: unknown, charging, discharging, not-charging, full/,
    );
  });

  test("gsm signal accepts 99 as 'unknown' for both components and bounds the rest", () => {
    expect(buildGsmSignalCommand(99, 99)).toBe("gsm signal 99 99");
    expect(buildGsmSignalCommand(31)).toBe("gsm signal 31");
    expect(() => buildGsmSignalCommand(-1)).toThrow(/rssi/);
    expect(() => buildGsmSignalCommand(10, 8)).toThrow(/ber/);
  });

  test("network delay supports a fixed value and rejects an inverted range", () => {
    expect(buildNetworkDelayCommand({ minMs: 150 })).toBe("network delay 150");
    expect(() => buildNetworkDelayCommand({ minMs: 500, maxMs: 100 })).toThrow(/must not be less/);
    expect(() => buildNetworkDelayCommand({ minMs: Number.NaN })).toThrow(/minMs/);
  });

  test("network speed rejects negative or non-finite rates", () => {
    expect(() => buildNetworkSpeedCommand({ upKbps: -1, downKbps: 10 })).toThrow(/upKbps/);
    expect(() => buildNetworkSpeedCommand({ upKbps: 1, downKbps: Infinity })).toThrow(/downKbps/);
  });

  test("sensor set rejects non-finite values and too many components", () => {
    expect(() => buildSensorSetCommand("acceleration", [1, Number.NaN])).toThrow(/finite/);
    expect(() => buildSensorSetCommand("acceleration", [1, 2, 3, 4])).toThrow(/1 to 3 values/);
    expect(buildSensorSetCommand("light", [400])).toBe("sensor set light 400");
  });

  test("parseSensorGetOutput matches only the requested sensor's line", () => {
    const output = "magnetic-field = 1:2:3\nmagnetic-field-uncalibrated = 4:5:6\nOK\n";
    expect(parseSensorGetOutput("magnetic-field", output)).toEqual([1, 2, 3]);
    expect(() => parseSensorGetOutput("light", output)).toThrow(/sensor 'light'/);
    expect(() => parseSensorGetOutput("light", "light = abc\nOK\n")).toThrow(/sensor 'light'/);
    expect(() => parseSensorGetOutput("light", "light = \nOK\n")).toThrow(/sensor 'light'/);
  });
});
