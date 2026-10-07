import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { DUMPSYS_MAX_BUFFER } from "../../../src/utils/android-cmdline-tools/dumpsysLimits";
import { createExecResult } from "../../../src/utils/execResult";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { describe, expect, spyOn, test } from "bun:test";
import {
  findAndroidPackageProcessId,
  findAndroidPackageProcesses,
  isAndroidPackageRunning,
  readAndroidPackageProcesses,
} from "../../../src/utils/android-cmdline-tools/androidProcessState";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const COMMAND = "shell dumpsys activity processes";
const PROCESS_LIST = "  *APP* UID 10001 ProcessRecord{abc 1234:com.example.app/u0a1}";

describe("androidProcessState", () => {
  test("finds the main process PID for the selected app user", () => {
    const output = [
      "*APP* UID u0a123 ProcessRecord{aaa 111:com.example.app/u0a123}",
      "*APP* UID u10a123 ProcessRecord{bbb 222:com.example.app/u10a123}",
    ].join("\n");

    expect(findAndroidPackageProcessId(output, "com.example.app", 10)).toBe(222);
    expect(isAndroidPackageRunning(output, "com.example.app", 10)).toBe(true);
  });

  test("maps numeric system UIDs to their Android user", () => {
    const output = "*APP* UID 1000 ProcessRecord{aaa 30779:com.android.settings/1000}";

    expect(findAndroidPackageProcessId(output, "com.android.settings", 0)).toBe(30779);
    expect(findAndroidPackageProcessId(output, "com.android.settings", 10)).toBeNull();
  });

  test("prefers the main process over a secondary package process", () => {
    const output = [
      "*APP* UID u0a123 ProcessRecord{aaa 444:com.example.app:worker/u0a123}",
      "*APP* UID u0a123 ProcessRecord{bbb 555:com.example.app/u0a123}",
    ].join("\n");

    expect(findAndroidPackageProcessId(output, "com.example.app", 0)).toBe(555);
  });

  test("returns a secondary process when it is the package's only running process", () => {
    const output = "*APP* UID u0a123 ProcessRecord{aaa 444:com.example.app:worker/u0a123}";

    expect(findAndroidPackageProcessId(output, "com.example.app", 0)).toBe(444);
  });

  test("lists package-owned process identities across Android users", () => {
    const output = [
      "*APP* UID u0a123 ProcessRecord{aaa 111:com.example.app/u0a123}",
      "*APP* UID u0a123 ProcessRecord{bbb 222:com.example.app:worker/u0a123}",
      "*APP* UID u10a123 ProcessRecord{ccc 333:com.example.app/u10a123}",
      "*APP* UID u10i42 ProcessRecord{ddd 444:com.example.app:isolated/u10i42}",
    ].join("\n");

    expect(findAndroidPackageProcesses(output, "com.example.app")).toEqual([
      { pid: 111, processName: "com.example.app", userId: 0 },
      { pid: 222, processName: "com.example.app:worker", userId: 0 },
      { pid: 333, processName: "com.example.app", userId: 10 },
      { pid: 444, processName: "com.example.app:isolated", userId: 10 },
    ]);
  });

  test("finds a package running only in a fully qualified custom process", () => {
    const output = [
      "*APP* UID u10a123 ProcessRecord{aaa 777:com.example.shared/u10a123}",
      "    packageList={com.example.app, com.example.library}",
      "*APP* UID u0a456 ProcessRecord{bbb 888:com.example.other/u0a456}",
      "    packageList={com.example.other}",
    ].join("\n");

    expect(findAndroidPackageProcesses(output, "com.example.app")).toEqual([
      { pid: 777, processName: "com.example.shared", userId: 10 },
    ]);
    expect(isAndroidPackageRunning(output, "com.example.app", 10)).toBe(true);
    expect(findAndroidPackageProcessId(output, "com.example.app", 10)).toBe(777);
  });
});

describe("readAndroidPackageProcesses", () => {
  test("returns running state and process identities for a matching package", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(COMMAND, result(PROCESS_LIST));

    const state = await readAndroidPackageProcesses(adb, "com.example.app", { userId: 0 });

    expect(state.stdout).toBe(PROCESS_LIST);
    expect(state.isRunning).toBe(true);
    expect(state.processes).toEqual([{ pid: 1234, processName: "com.example.app", userId: 0 }]);
    expect(adb.getCommandCalls()).toEqual([
      expect.objectContaining({ command: COMMAND, timeoutMs: 5_000, noRetry: true }),
    ]);
  });

  test("returns false for a package with no matching process or a different user", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(COMMAND, result(PROCESS_LIST));
    expect(
      (await readAndroidPackageProcesses(adb, "com.example.app", { userId: 10 })).isRunning,
    ).toBe(false);
    expect((await readAndroidPackageProcesses(adb, "com.example.other")).isRunning).toBe(false);
  });

  test("retries one transient failure through the injected timer", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    adb.setCommandResponse(COMMAND, result(PROCESS_LIST));
    const execute = adb.executeCommand.bind(adb);
    let attempts = 0;
    const calls: Parameters<typeof adb.executeCommand>[] = [];
    spyOn(adb, "executeCommand").mockImplementation(async (...args) => {
      attempts += 1;
      calls.push(args);
      if (attempts === 1) {
        throw new Error("adb: device offline");
      }
      return execute(...args);
    });

    const state = await readAndroidPackageProcesses(adb, "com.example.app", { timer });

    expect(state.isRunning).toBe(true);
    expect(calls).toEqual([
      [COMMAND, 5_000, DUMPSYS_MAX_BUFFER, true, undefined],
      [COMMAND, 5_000, DUMPSYS_MAX_BUFFER, true, undefined],
    ]);
    expect(timer.now()).toBe(200);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("surfaces a second offline failure after exactly one retry", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let attempts = 0;
    spyOn(adb, "executeCommand").mockImplementation(async () => {
      attempts += 1;
      throw new Error("adb: device offline");
    });

    await expect(readAndroidPackageProcesses(adb, "com.example.app", { timer })).rejects.toThrow(
      "device offline",
    );
    expect(attempts).toBe(2);
    expect(timer.now()).toBe(200);
  });

  test("does not retry a non-transient failure", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    let attempts = 0;
    spyOn(adb, "executeCommand").mockImplementation(async () => {
      attempts += 1;
      throw new Error("unknown command");
    });

    await expect(readAndroidPackageProcesses(adb, "com.example.app", { timer })).rejects.toThrow(
      "unknown command",
    );
    expect(attempts).toBe(1);
    expect(timer.now()).toBe(0);
  });
});

function result(stdout: string) {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

test("launchApp's process reader forwards the bound through fake exec for a large dump", async () => {
  // Pad the existing process parser unit vector, not an invented captured fixture.
  const padding = "  filler_feature_flag=true\n".repeat(50_000);
  const stdout = padding + PROCESS_LIST + "\n" + padding;
  expect(Buffer.byteLength(stdout)).toBeGreaterThan(1024 * 1024);
  const timer = new FakeTimer();
  const adb = new AdbClient(
    null,
    async (_file, args, maxBuffer) => {
      expect(args).toEqual(["shell", "dumpsys activity processes"]);
      expect(maxBuffer).toBe(DUMPSYS_MAX_BUFFER);
      expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(maxBuffer ?? 1024 * 1024);
      return createExecResult(stdout, "");
    },
    null,
    new DefaultRetryExecutor(timer),
    timer,
  );
  const state = await readAndroidPackageProcesses(adb, "com.example.app", { userId: 0, timer });
  expect(state.isRunning).toBe(true);
  expect(state.processes).toEqual([{ pid: 1234, processName: "com.example.app", userId: 0 }]);
  expect(state.stdout).toBe(stdout);
});
