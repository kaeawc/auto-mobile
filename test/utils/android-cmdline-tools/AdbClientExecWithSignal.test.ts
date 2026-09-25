import { EventEmitter } from "node:events";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ChildProcess } from "child_process";
import {
  AdbClient,
  AdbCommandTimeoutError,
  adbHostProcessExecutor,
} from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { StartedHostCommand } from "../../../src/utils/HostCommandExecutor";
import { DefaultRetryExecutor, defaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";

type AdbClientInternals = {
  isTestMode: boolean;
  execWithSignal: (
    file: string,
    args: string[],
    maxBuffer?: number,
    timeoutMs?: number,
    signal?: AbortSignal,
    waitForProcessSettlementAfterAbort?: boolean,
  ) => Promise<unknown>;
};

const originalExecuteCommandWithChild = adbHostProcessExecutor.executeCommandWithChild;

describe.serial("AdbClient execWithSignal shared process seam", () => {
  afterEach(() => {
    adbHostProcessExecutor.executeCommandWithChild = originalExecuteCommandWithChild;
  });

  for (const { name, explicitTimeoutMs, advanceBeforeKillMs, killAtMs } of [
    { name: "default", explicitTimeoutMs: undefined, advanceBeforeKillMs: 14, killAtMs: 15 },
    { name: "short explicit", explicitTimeoutMs: 5, advanceBeforeKillMs: 4, killAtMs: 5 },
    { name: "long explicit", explicitTimeoutMs: 30, advanceBeforeKillMs: 16, killAtMs: 30 },
  ]) {
    test(`${name} command timeout kills the adb child at its budget`, async () => {
      const timer = new FakeTimer();
      const child = new EventEmitter() as ChildProcess;
      const signals: (string | number | undefined)[] = [];
      child.kill = (signal) => {
        signals.push(signal);
        return true;
      };
      let dispatches = 0;
      adbHostProcessExecutor.executeCommandWithChild = (): StartedHostCommand => {
        dispatches++;
        return { child, result: new Promise(() => {}) };
      };
      const client = new AdbClient(
        null,
        null,
        null,
        defaultRetryExecutor,
        timer,
        undefined,
        undefined,
        undefined,
        15,
      );
      const internals = client as unknown as AdbClientInternals & {
        getBaseCommandParts: () => Promise<{ adbPath: string; baseArgs: string[] }>;
      };
      internals.isTestMode = false;
      internals.getBaseCommandParts = async () => ({ adbPath: "adb", baseArgs: [] });
      const result = client.executeCommand("shell input tap 1 2", explicitTimeoutMs);
      await Promise.resolve();
      await Promise.resolve();
      expect(dispatches).toBe(1);
      timer.advanceTime(advanceBeforeKillMs);
      expect(signals).toEqual([]);
      timer.advanceTime(killAtMs - advanceBeforeKillMs);
      await expect(result).rejects.toBeInstanceOf(AdbCommandTimeoutError);
      expect(signals).toEqual(["SIGTERM"]);
      expect(dispatches).toBe(1);
    });
  }

  test("keeps the dispatched timeout error when a read retries after its budget expires", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const child = new EventEmitter() as ChildProcess;
    child.kill = () => true;
    let dispatches = 0;
    adbHostProcessExecutor.executeCommandWithChild = (): StartedHostCommand => {
      dispatches++;
      return { child, result: new Promise(() => {}) };
    };
    const client = new AdbClient(null, null, null, new DefaultRetryExecutor(timer), timer);
    const internals = client as unknown as AdbClientInternals & {
      getBaseCommandParts: () => Promise<{ adbPath: string; baseArgs: string[] }>;
    };
    internals.isTestMode = false;
    internals.getBaseCommandParts = async () => ({ adbPath: "adb", baseArgs: [] });

    const result = client.executeCommand("shell getprop", 5);
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatches).toBe(1);
    timer.advanceTime(5);

    await expect(result).rejects.toThrow("Command timed out after 5ms: adb shell getprop");
    expect(dispatches).toBe(1);
  });

  test("keeps the injected timeout error when SIGTERM rejects during graceful settlement", async () => {
    const timer = new FakeTimer();
    const child = new EventEmitter() as ChildProcess;
    let rejectResult: ((error: Error) => void) | undefined;
    child.kill = () => {
      rejectResult?.(new Error("terminated by SIGTERM"));
      return true;
    };
    adbHostProcessExecutor.executeCommandWithChild = (): StartedHostCommand => ({
      child,
      result: new Promise((_, reject) => {
        rejectResult = reject;
      }),
    });

    const client = new AdbClient(null, null, null, defaultRetryExecutor, timer);
    const internals = client as unknown as AdbClientInternals;
    internals.isTestMode = false;

    const result = internals.execWithSignal(
      "adb",
      ["shell", "getprop"],
      undefined,
      5,
      undefined,
      true,
    );
    timer.advanceTime(5);

    await expect(result).rejects.toBeInstanceOf(AdbCommandTimeoutError);
    await expect(result).rejects.toThrow("Command timed out after 5ms: adb shell getprop");
  });

  test("waits for the child exit after SIGKILL before rejecting a timed-out command", async () => {
    const timer = new FakeTimer();
    const child = new EventEmitter() as ChildProcess;
    const signals: (string | number | undefined)[] = [];
    child.kill = (signal) => {
      signals.push(signal);
      return true;
    };
    adbHostProcessExecutor.executeCommandWithChild = (): StartedHostCommand => ({
      child,
      result: new Promise(() => {}),
    });

    const client = new AdbClient(null, null, null, defaultRetryExecutor, timer);
    const internals = client as unknown as AdbClientInternals;
    internals.isTestMode = false;
    let settled = false;
    const result = internals.execWithSignal(
      "adb",
      ["shell", "getprop"],
      undefined,
      5,
      undefined,
      true,
    );
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    timer.advanceTime(5);
    timer.advanceTime(1_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settled).toBe(false);

    child.emit("exit");

    await expect(result).rejects.toBeInstanceOf(AdbCommandTimeoutError);
  });

  test("waits for the child exit after SIGKILL before rejecting an aborted command", async () => {
    const timer = new FakeTimer();
    const child = new EventEmitter() as ChildProcess;
    const signals: (string | number | undefined)[] = [];
    child.kill = (signal) => {
      signals.push(signal);
      return true;
    };
    adbHostProcessExecutor.executeCommandWithChild = (): StartedHostCommand => ({
      child,
      result: new Promise(() => {}),
    });

    const client = new AdbClient(null, null, null, defaultRetryExecutor, timer);
    const internals = client as unknown as AdbClientInternals;
    internals.isTestMode = false;
    const controller = new AbortController();
    let settled = false;
    const result = internals.execWithSignal(
      "adb",
      ["shell", "getprop"],
      undefined,
      undefined,
      controller.signal,
      true,
    );
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    controller.abort();
    timer.advanceTime(1_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settled).toBe(false);

    child.emit("exit");

    await expect(result).rejects.toThrow("Operation cancelled");
  });

  test("warns and rejects after SIGKILL when the child never exits", async () => {
    const timer = new FakeTimer();
    const child = new EventEmitter() as ChildProcess;
    child.kill = () => true;
    adbHostProcessExecutor.executeCommandWithChild = (): StartedHostCommand => ({
      child,
      result: new Promise(() => {}),
    });
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

    const client = new AdbClient(null, null, null, defaultRetryExecutor, timer);
    const internals = client as unknown as AdbClientInternals;
    internals.isTestMode = false;
    const result = internals.execWithSignal(
      "adb",
      ["shell", "getprop"],
      undefined,
      5,
      undefined,
      true,
    );

    timer.advanceTime(5);
    timer.advanceTime(1_000);
    timer.advanceTime(1_000);

    await expect(result).rejects.toBeInstanceOf(AdbCommandTimeoutError);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("did not exit after SIGKILL"));
  });
});
