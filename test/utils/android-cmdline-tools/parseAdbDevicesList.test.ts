import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAdbDevicesList } from "../../../src/utils/android-cmdline-tools/parseAdbDevicesList";
import { transportIdFor } from "../../../src/utils/androidSerial";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-adb", name), "utf8");

const summarize = (stdout: string) =>
  parseAdbDevicesList(stdout).map((row) => ({
    deviceId: row.deviceId,
    state: row.state,
    transportId: transportIdFor(row as never),
  }));

describe("parseAdbDevicesList", () => {
  test("captured adb devices -l lists both emulators with transport ids", () => {
    expect(summarize(fixture("adb-devices-l.txt"))).toEqual([
      { deviceId: "emulator-5554", state: "device", transportId: "1" },
      { deviceId: "emulator-5556", state: "device", transportId: "10" },
    ]);
  });

  // Supplementary hand-typed shapes (no capture of these states yet).
  const supplementary: Array<[string, string, ReturnType<typeof summarize>]> = [
    ["header only", "List of devices attached\n\n", []],
    ["empty output", "", []],
    [
      "offline and unauthorized rows are kept with their state",
      "List of devices attached\nemulator-5554 offline transport_id:2\nABC123 unauthorized usb:1-1 transport_id:3\n",
      [
        { deviceId: "emulator-5554", state: "offline", transportId: "2" },
        { deviceId: "ABC123", state: "unauthorized", transportId: "3" },
      ],
    ],
    [
      "row without transport_id",
      "List of devices attached\nemulator-5554\tdevice\n",
      [{ deviceId: "emulator-5554", state: "device", transportId: undefined }],
    ],
    ["serial without a state is dropped", "List of devices attached\nlonely\n", []],
  ];
  test.each(supplementary)("supplementary: %s", (_name, stdout, expected) => {
    expect(summarize(stdout)).toEqual(expected);
  });
});
