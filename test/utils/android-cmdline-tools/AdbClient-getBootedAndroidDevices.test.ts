import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AdbClient, resetAdbClientCaches } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { ExecResult } from "../../../src/models";
import { isAdbMissingDeviceError } from "../../../src/utils/android-cmdline-tools/AdbDeviceHealth";

function createExecResult(stdout: string, stderr: string = ""): ExecResult {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (searchString: string) => stdout.includes(searchString),
  };
}

describe("AdbClient.getBootedAndroidDevices", () => {
  beforeEach(() => {
    resetAdbClientCaches();
  });

  afterEach(() => {
    resetAdbClientCaches();
  });

  test("only reports adb rows in device state as booted", async () => {
    const execAsync = async (command: string): Promise<ExecResult> => {
      if (command.includes("adb devices")) {
        return createExecResult([
          "List of devices attached",
          "emulator-5554\tdevice",
          "emulator-5556\tbooting",
          "emulator-5558\toffline",
          "emulator-5560\tunauthorized",
          "",
        ].join("\n"));
      }
      return createExecResult("");
    };
    const adb = new AdbClient(null, execAsync);

    const devices = await adb.getBootedAndroidDevices();

    expect(devices).toEqual([
      { name: "emulator-5554", platform: "android", deviceId: "emulator-5554" },
    ]);
  });

  test("does not retry commands when adb reports the target serial is gone", async () => {
    let calls = 0;
    const execAsync = async (): Promise<ExecResult> => {
      calls++;
      throw new Error("Command failed: adb -s emulator-5554 shell true\nstderr: adb: device 'emulator-5554' not found");
    };
    const adb = new AdbClient(
      { name: "Pixel 8", platform: "android", deviceId: "emulator-5554" },
      execAsync
    );

    await expect(adb.executeCommand("shell true")).rejects.toThrow(/device 'emulator-5554' not found/);
    expect(calls).toBe(1);
  });

  test("does not treat generic no-device output as serial-specific disappearance", () => {
    expect(isAdbMissingDeviceError(new Error("error: no devices/emulators found"), "emulator-5554")).toBe(false);
    expect(isAdbMissingDeviceError(new Error("error: device not found"), "emulator-5554")).toBe(false);
    expect(isAdbMissingDeviceError(new Error("adb: device 'emulator-5554' not found"), "emulator-5554")).toBe(true);
  });
});
