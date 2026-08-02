import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AdbClient,
  AdbCommandTimeoutError,
  resetAdbClientCaches,
} from "../../../src/utils/android-cmdline-tools/AdbClient";
import { clearDetectionCache } from "../../../src/utils/android-cmdline-tools/detection";
import { defaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { ExecResult } from "../../../src/models";
import type { SystemDetection } from "../../../src/utils/system/SystemDetection";

const ANDROID_ENV_NAMES = ["ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_SDK_HOME"] as const;
const savedAndroidEnvironment = new Map(
  ANDROID_ENV_NAMES.map(name => [name, process.env[name]])
);

type AdbClientInternals = {
  isTestMode: boolean;
  execAsync: (file: string, args: string[], maxBuffer?: number) => Promise<ExecResult>;
  execWithSignal: (
    file: string,
    args: string[],
    maxBuffer?: number,
    timeoutMs?: number,
    signal?: AbortSignal
  ) => Promise<ExecResult>;
};

function ok(stdout = ""): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (value: string) => stdout.includes(value),
  };
}

describe.serial("AdbClient ADB-path discovery deadline", () => {
  beforeEach(() => {
    resetAdbClientCaches();
    clearDetectionCache();
    for (const name of ANDROID_ENV_NAMES) {
      delete process.env[name];
    }
  });

  afterEach(() => {
    resetAdbClientCaches();
    clearDetectionCache();
    for (const name of ANDROID_ENV_NAMES) {
      const value = savedAndroidEnvironment.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  test("fails the request budget when a cold-cache path probe stalls", async () => {
    const timer = new FakeTimer();
    const client = new AdbClient(null, null, null, defaultRetryExecutor, timer);
    const internals = client as unknown as AdbClientInternals;
    internals.isTestMode = false;
    internals.execAsync = async () => new Promise<ExecResult>(() => {});
    internals.execWithSignal = async (_file, _args, _maxBuffer, timeoutMs) =>
      new Promise<ExecResult>((_resolve, reject) => {
        timer.setTimeout(
          () => reject(new AdbCommandTimeoutError(`Command timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      });

    let settled: unknown = undefined;
    void client.execute(["shell", "true"], { timeoutMs: 20, noRetry: true })
      .then(() => { settled = new Error("expected discovery to time out"); })
      .catch(error => { settled = error; });

    await Promise.resolve();
    timer.advanceTime(20);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(settled).toBeInstanceOf(AdbCommandTimeoutError);
  });

  test("passes only the remaining request budget to the command after discovery", async () => {
    const timer = new FakeTimer();
    const client = new AdbClient(null, null, null, defaultRetryExecutor, timer);
    const internals = client as unknown as AdbClientInternals;
    internals.isTestMode = false;
    internals.execAsync = async (file, args) => {
      expect([file, ...args]).toEqual(["which", "adb"]);
      timer.advanceTime(7);
      return ok("/sdk/platform-tools/adb\n");
    };

    const commandTimeouts: number[] = [];
    internals.execWithSignal = async (file, args, _maxBuffer, timeoutMs) => {
      if (file === "which" && args[0] === "adb") {
        timer.advanceTime(7);
        return ok("/sdk/platform-tools/adb\n");
      }
      if (file.endsWith("/adb") && args[0] === "shell") {
        commandTimeouts.push(timeoutMs ?? -1);
      }
      return ok();
    };

    await client.execute(["shell", "true"], { timeoutMs: 20, noRetry: true });

    expect(commandTimeouts).toEqual([13]);
  });

  test("propagates a fallback-detection timeout and does not cache an incomplete resolution", async () => {
    const timer = new FakeTimer();
    const client = new AdbClient(null, null, null, defaultRetryExecutor, timer);
    const internals = client as unknown as AdbClientInternals;
    internals.isTestMode = false;
    let recover = false;
    let adbPathProbeCalls = 0;
    const executedCommands: string[] = [];
    internals.execWithSignal = async (file, args, _maxBuffer, timeoutMs) => {
      const command = [file, ...args].join(" ");
      executedCommands.push(command);
      if (command === "which adb") {
        adbPathProbeCalls += 1;
        return recover ? ok("/sdk/platform-tools/adb\n") : ok("");
      }
      if (file.endsWith("/adb")) {
        return ok();
      }
      return new Promise<ExecResult>((_resolve, reject) => {
        timer.setTimeout(
          () => reject(new AdbCommandTimeoutError(`Command timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      });
    };

    let firstFailure: unknown = undefined;
    void client.execute(["shell", "true"], { timeoutMs: 20, noRetry: true })
      .catch(error => { firstFailure = error; });
    await Promise.resolve();
    timer.advanceTime(20);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(firstFailure).toBeInstanceOf(AdbCommandTimeoutError);
    expect(executedCommands).not.toContain("adb shell true");

    recover = true;
    await client.execute(["shell", "true"], { timeoutMs: 20, noRetry: true });

    expect(adbPathProbeCalls).toBe(2);
  });

  test("does not cache the fallback path when an environment probe is aborted", async () => {
    process.env.ANDROID_HOME = "/sdk";
    const client = new AdbClient(null, null, null, defaultRetryExecutor, new FakeTimer());
    const internals = client as unknown as AdbClientInternals;
    internals.isTestMode = false;
    let versionProbeCalls = 0;
    const commandFiles: string[] = [];
    internals.execWithSignal = async (file, args, _maxBuffer, _timeoutMs, signal) => {
      if (signal?.aborted) {
        throw new Error("probe aborted");
      }
      if (file === "/sdk/platform-tools/adb" && args[0] === "version") {
        versionProbeCalls += 1;
        if (versionProbeCalls === 1) {
          return new Promise<ExecResult>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("probe aborted")), { once: true });
          });
        }
        return ok();
      }
      if (args[0] === "shell") {
        commandFiles.push(file);
      }
      return ok();
    };

    const controller = new AbortController();
    const aborted = client.execute(["shell", "true"], { noRetry: true, signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(aborted).rejects.toThrow("Operation cancelled");

    await client.execute(["shell", "true"], { noRetry: true });

    expect(commandFiles).toEqual(["/sdk/platform-tools/adb"]);
    expect(versionProbeCalls).toBe(2);
  });

  test("does not cache the fallback path when a later tool-discovery probe is aborted", async () => {
    const client = new AdbClient(null, null, null, defaultRetryExecutor, new FakeTimer());
    const internals = client as unknown as AdbClientInternals;
    internals.isTestMode = false;
    let adbPathProbeCalls = 0;
    const commandFiles: string[] = [];
    internals.execWithSignal = async (file, args, _maxBuffer, _timeoutMs, signal) => {
      if (signal?.aborted) {
        throw new Error("probe aborted");
      }
      if (file === "which" && args[0] === "adb") {
        adbPathProbeCalls += 1;
        return adbPathProbeCalls === 1 ? ok("") : ok("/sdk/platform-tools/adb\n");
      }
      if (file === "which") {
        return new Promise<ExecResult>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("probe aborted")), { once: true });
        });
      }
      if (args[0] === "shell") {
        commandFiles.push(file);
      }
      return ok();
    };

    const controller = new AbortController();
    const aborted = client.execute(["shell", "true"], { noRetry: true, signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(aborted).rejects.toThrow("Operation cancelled");

    await client.execute(["shell", "true"], { noRetry: true });

    expect(adbPathProbeCalls).toBe(2);
    expect(commandFiles).toEqual(["/sdk/platform-tools/adb"]);
  });

  test("times out instead of blocking on a stalled fallback filesystem probe", async () => {
    const timer = new FakeTimer();
    let fileProbeStarted = false;
    const commandFiles: string[] = [];
    const stalledSystemDetection: SystemDetection = {
      getCurrentPlatform: () => "darwin",
      getHomeDir: () => "/Users/test",
      getEnvVar: () => undefined,
      fileExistsSync: () => false,
      fileExists: async () => {
        fileProbeStarted = true;
        return new Promise<boolean>(() => {});
      },
      executeCommand: async () => {
        throw new Error("command not found");
      },
    };
    const client = new AdbClient(
      null,
      null,
      null,
      defaultRetryExecutor,
      timer,
      () => stalledSystemDetection
    );
    const internals = client as unknown as AdbClientInternals;
    internals.isTestMode = false;
    internals.execWithSignal = async (file, args) => {
      if (file === "which" && args[0] === "adb") {
        return ok("");
      }
      if (args[0] === "shell") {
        commandFiles.push(file);
      }
      return ok();
    };

    let settled: unknown = undefined;
    void client.execute(["shell", "true"], { timeoutMs: 20, noRetry: true })
      .catch(error => { settled = error; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fileProbeStarted).toBe(true);
    timer.advanceTime(20);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(settled).toBeInstanceOf(AdbCommandTimeoutError);
    expect(commandFiles).toEqual([]);
  });
});
