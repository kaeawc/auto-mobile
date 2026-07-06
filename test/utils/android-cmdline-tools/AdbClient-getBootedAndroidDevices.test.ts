import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AdbClient, resetAdbClientCaches } from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { ExecResult } from "../../../src/models";

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
});
