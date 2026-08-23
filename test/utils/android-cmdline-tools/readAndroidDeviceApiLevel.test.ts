import { describe, expect, test } from "bun:test";
import { readAndroidDeviceApiLevel } from "../../../src/utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import type { AdbExecutor } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const GETPROP = "shell getprop ro.build.version.sdk";

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

describe("readAndroidDeviceApiLevel", () => {
  test("returns the executor's cached API level without probing getprop when available", async () => {
    const adb = new FakeAdbExecutor();
    adb.setAndroidApiLevel(31);
    adb.setCommandResponse(GETPROP, execResult("29"));

    const level = await readAndroidDeviceApiLevel(adb);

    expect(level).toBe(31);
    // The fast path must not fall through to a getprop probe when the client answered.
    expect(adb.getExecutedCommands().some((c) => c.includes("getprop ro.build.version.sdk"))).toBe(
      false,
    );
  });

  test("falls back to getprop when the executor's API level reads null", async () => {
    const adb = new FakeAdbExecutor();
    adb.setAndroidApiLevel(null);
    adb.setCommandResponse(GETPROP, execResult("29"));

    const level = await readAndroidDeviceApiLevel(adb);

    expect(level).toBe(29);
    expect(adb.getExecutedCommands().some((c) => c.includes("getprop ro.build.version.sdk"))).toBe(
      true,
    );
  });

  test("reads getprop when the executor exposes no API-level method at all", async () => {
    // A bare executor with no getAndroidApiLevel method exercises the
    // `typeof extended.getAndroidApiLevel === "function"` duck-typing guard.
    // No existing fake has this shape (FakeAdbExecutor defines the method), so a
    // minimal literal is the only way to cover the false branch of the guard.
    const executed: string[] = [];
    const bareExecutor = {
      executeCommand: async (command: string): Promise<ExecResult> => {
        executed.push(command);
        return execResult("33");
      },
    } as unknown as AdbExecutor;

    const level = await readAndroidDeviceApiLevel(bareExecutor);

    expect(level).toBe(33);
    expect(executed).toEqual([GETPROP]);
  });

  test("returns null when getprop yields a non-numeric value", async () => {
    const adb = new FakeAdbExecutor();
    adb.setAndroidApiLevel(null);
    adb.setCommandResponse(GETPROP, execResult("not-a-number"));

    expect(await readAndroidDeviceApiLevel(adb)).toBeNull();
  });

  test("returns null when the getprop probe throws", async () => {
    const adb = new FakeAdbExecutor();
    adb.setAndroidApiLevel(null);
    adb.setCommandError(GETPROP, new Error("device offline"));

    expect(await readAndroidDeviceApiLevel(adb)).toBeNull();
  });
});
