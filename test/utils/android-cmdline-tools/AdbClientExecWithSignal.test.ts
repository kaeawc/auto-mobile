import { EventEmitter } from "node:events";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ChildProcess } from "child_process";
import {
  AdbClient,
  AdbCommandTimeoutError,
  adbHostProcessExecutor,
} from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { StartedHostCommand } from "../../../src/utils/HostCommandExecutor";
import { defaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
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
