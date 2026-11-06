import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAdbReverseCommands } from "../../../src/utils/android-cmdline-tools/adbReverse";
import {
  DEVICE_LISTENERS_SCRIPT,
  packageForUid,
  parseDeviceListeners,
} from "../../../src/utils/android-cmdline-tools/deviceTcpListeners";

// Captured by running DEVICE_LISTENERS_SCRIPT with `sh -c` on a Linux 6.18 host kernel (the same
// procfs table Android's kernel prints) while root listened on 127.0.0.1:38081 (with one
// established connection to it) and uid 65534 listened on 0.0.0.0:38083. That host has no IPv6,
// so the tcp6 section is cat's missing-file error. Rows with a non-loopback address were dropped
// whole before committing; kept rows are unedited. An Android capture with tcp6 rows is listed
// for the device lane.
const capture = readFileSync(
  join(import.meta.dir, "../../fixtures/port-reverse-device-listener/linux-host-listeners.txt"),
  "utf8",
);

// The `pm list packages -U` rows used by test/features/deviceLogs/AndroidLogReader.test.ts.
const APP = "dev.jasonpearson.automobile.playground";
const PM_LIST = `package:${APP}.debug uid:10999\npackage:${APP} uid:10123\n`;

describe("device TCP listeners", () => {
  test("LISTEN rows on loopback or wildcard addresses map port to uid", () => {
    const table = parseDeviceListeners(capture);
    expect(table.kind).toBe("ok");
    if (table.kind !== "ok") {
      return;
    }
    expect(table.listeners.get(38081)).toEqual([0]);
    expect(table.listeners.get(38083)).toEqual([65534]);
    expect([...table.listeners.keys()].sort((a, b) => a - b)).toEqual([
      2024, 38081, 38083, 39137, 45305,
    ]);
  });

  test("established and TIME_WAIT rows are not listeners", () => {
    const table = parseDeviceListeners(capture);
    // 0x892C and 0xE998 are client ends of connections in the capture.
    expect(table.kind === "ok" && table.listeners.has(0x892c)).toBe(false);
    expect(table.kind === "ok" && table.listeners.has(0xe998)).toBe(false);
  });

  test("a table no file could be read for is unsupported, with the device's text", () => {
    const tcp6Only = capture.slice(capture.indexOf("automobile-proc-file=/proc/net/tcp6"));
    expect(parseDeviceListeners(tcp6Only)).toEqual({
      kind: "unsupported",
      detail: "cat: /proc/net/tcp6: No such file or directory",
    });
    expect(parseDeviceListeners("")).toEqual({ kind: "unsupported", detail: "no output" });
  });

  test("packageForUid names the one package with that uid", () => {
    expect(packageForUid(PM_LIST, 10123)).toBe(APP);
    expect(packageForUid(PM_LIST, 10999)).toBe(`${APP}.debug`);
    expect(packageForUid(PM_LIST, 2000)).toBeUndefined();
  });

  test("listeners runs one bounded shell script and packageForUid one pm call", async () => {
    const commands: string[] = [];
    const reverse = createAdbReverseCommands({
      executeCommand: async (command: string) => {
        commands.push(command);
        return { stdout: command.includes("pm list") ? PM_LIST : capture, stderr: "" } as never;
      },
    });
    expect((await reverse.listeners()).kind).toBe("ok");
    expect(await reverse.packageForUid(10123)).toBe(APP);
    expect(commands).toEqual([
      `shell sh -c '${DEVICE_LISTENERS_SCRIPT}'`,
      "shell pm list packages -U",
    ]);
  });
});
