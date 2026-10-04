import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AndroidDeviceResourceReader } from "../../src/utils/androidDeviceResourceReader";
import type { DeviceResourceObservationRequest } from "../../src/utils/deviceResourceObserver";
import type { AndroidResourceRestoration } from "../../src/models/AndroidResourceRestoration";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

type Entry = AndroidResourceRestoration["entries"][number];
const playground = "dev.jasonpearson.automobile.playground";
const captures = [
  { file: "dumpsys-package-installed.txt", target: playground, value: "0" },
  { file: "dumpsys-package-not-installed.txt", target: "com.example.not.installed", value: null },
  { file: "dumpsys-package-suspended.txt", target: playground, value: null },
  { file: "dumpsys-package-hidden.txt", target: playground, value: null },
  { file: "dumpsys-package-disabled-user.txt", target: playground, value: "3" },
  { file: "dumpsys-package-uninstalled-user0-keepdata.txt", target: playground, value: null },
  { file: "dumpsys-package-system-installed.txt", target: "com.android.egg", value: "0" },
  { file: "dumpsys-package-system-uninstalled-user0.txt", target: "com.android.egg", value: null },
].map((capture) => ({
  ...capture,
  output: readFileSync(
    new URL(`../fixtures/android-dumpsys-package/${capture.file}`, import.meta.url),
    "utf8",
  ),
}));

function setup(capture: (typeof captures)[number]) {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  const reader = new AndroidDeviceResourceReader({ adbFactory: { create: () => adb }, timer });
  const request: DeviceResourceObservationRequest = {
    device: { platform: "android", deviceId: "emulator-5600", name: "package-state-test" },
    deadlineMs: timer.now() + 1000,
  };
  const entry: Entry = {
    resource: "mailApp",
    kind: "package",
    target: capture.target,
    value: null,
  };
  const shell = `'dumpsys' 'package' '${entry.target}'`;
  adb.setCommandResponse(shell, createExecResult(capture.output, ""));
  const run = reader.createRun(request);
  run.user = "0";
  return { adb, reader, run, entry, shell };
}

describe("AndroidDeviceResourceReader.read captured package state", () => {
  test.each(captures.filter((capture) => capture.value !== null))(
    "reads $file as override $value, ignoring the second User 0 section",
    async (capture) => {
      const userSections = capture.output
        .split("\n")
        .filter((line) => line.trimStart().startsWith("User 0:"));
      expect(userSections).toHaveLength(2);
      expect(userSections.filter((line) => line.includes("installed="))).toHaveLength(1);
      expect(userSections[1]!.trim()).toBe("User 0:");

      const { adb, reader, run, entry, shell } = setup(capture);
      const value = await reader.read(run, entry);
      expect(value).toBe(capture.value);
      expect(reader.state(entry, value)).toBe(capture.value === "3" ? "disabled" : "unknown");
      expect(adb.getExecutedArgv()).toEqual([["shell", shell]]);
    },
  );

  test.each(captures.filter((capture) => capture.value === null))(
    "rejects $file with the exact package verification error",
    async (capture) => {
      const { adb, reader, run, entry, shell } = setup(capture);
      await expect(reader.read(run, entry)).rejects.toEqual(
        new Error(`Cannot verify installed package override for ${entry.target}`),
      );
      expect(adb.getExecutedArgv()).toEqual([["shell", shell]]);
    },
  );

  test("rejects the installed capture for user 10 rather than reading user 0", async () => {
    const capture = captures[0]!;
    expect(capture.output).not.toContain("User 10:");
    const { adb, reader, run, entry, shell } = setup(capture);
    run.user = "10";
    await expect(reader.read(run, entry)).rejects.toEqual(
      new Error(`Cannot verify installed package override for ${entry.target}`),
    );
    expect(adb.getExecutedArgv()).toEqual([["shell", shell]]);
  });
});
