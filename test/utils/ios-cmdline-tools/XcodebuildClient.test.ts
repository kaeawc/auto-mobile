import { describe, expect, test } from "bun:test";
import { XcodebuildClient } from "../../../src/utils/ios-cmdline-tools/XcodebuildClient";
import type { ExecResult } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { DEFAULT_RUNNER_READINESS_TIMEOUT_MS } from "../../../src/utils/runnerReadinessConfig";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";

describe("XcodebuildClient executeCommand timeout", () => {
  test("aborts the underlying child process when the command times out", async () => {
    const timer = new FakeTimer();
    let capturedSignal: AbortSignal | undefined;
    const execAsync = async (
      _file: string,
      args: string[],
      _maxBuffer?: number,
      signal?: AbortSignal,
    ): Promise<ExecResult> => {
      // Availability probe runs first; answer it so executeCommand proceeds.
      if (args.join(" ") === "-version") {
        return createExecResult("Xcode 26.5", "");
      }
      capturedSignal = signal;
      // Simulate a long-running child that only settles when aborted, mirroring
      // execFile rejecting with an AbortError once its signal fires.
      return new Promise<ExecResult>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    };

    const client = new XcodebuildClient(execAsync, timer);

    const promise = client.executeCommand(["-showBuildSettings"], { timeoutMs: 1234 });
    while (!capturedSignal) {
      await Promise.resolve();
    }
    expect(capturedSignal.aborted).toBe(false);

    timer.advanceTime(1234);

    await expect(promise).rejects.toThrow(
      "Command timed out after 1234ms: xcodebuild -showBuildSettings",
    );
    // The timeout must abort the child rather than leave it running orphaned.
    expect(capturedSignal.aborted).toBe(true);
  });

  test("does not abort when the command completes before the timeout", async () => {
    const timer = new FakeTimer();
    let capturedSignal: AbortSignal | undefined;
    const execAsync = async (
      _file: string,
      args: string[],
      _maxBuffer?: number,
      signal?: AbortSignal,
    ): Promise<ExecResult> => {
      if (args.join(" ") === "-version") {
        return createExecResult("Xcode 26.5", "");
      }
      capturedSignal = signal;
      return createExecResult("ok", "");
    };

    const client = new XcodebuildClient(execAsync, timer);

    const result = await client.executeCommand(["-list"], { timeoutMs: 5000 });

    expect(result.stdout).toBe("ok");
    expect(capturedSignal?.aborted).toBe(false);
  });

  test("refuses to run a non-probe command when xcodebuild is not installed", async () => {
    // The only refusal branch in the file (executeCommand, not-a-probe path) was
    // untested. The availability probe (`-version`) fails, so a real command
    // must be turned away rather than executed against a missing toolchain.
    const client = new XcodebuildClient(async (_file, args) => {
      if (args.join(" ") === "-version") {
        throw new Error("xcodebuild: command not found");
      }
      return createExecResult("should not reach", "");
    });

    await expect(client.executeCommand(["-showBuildSettings"])).rejects.toThrow(
      "xcodebuild is not available. Please install Xcode to continue.",
    );
  });

  test("releases the injected timer handle after a timed command completes", async () => {
    // Timer hygiene: the finally must clear the timeout on the INJECTED timer, not
    // the global one, or the FakeTimer keeps a dangling pending timeout (a real
    // handle leak in production). getPendingTimeoutCount() must return to 0.
    const timer = new FakeTimer();
    const client = new XcodebuildClient(async (_file, args) => {
      if (args.join(" ") === "-version") {
        return createExecResult("Xcode 26.5", "");
      }
      return createExecResult("ok", "");
    }, timer);

    await client.executeCommand(["-list"], { timeoutMs: 5000 });

    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("bounds the availability probe within the command timeout", async () => {
    const timer = new FakeTimer();
    let probeSignal: AbortSignal | undefined;
    const client = new XcodebuildClient(async (_file, args, _maxBuffer, signal) => {
      if (args.join(" ") === "-version") {
        probeSignal = signal;
        return new Promise<ExecResult>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return createExecResult("ok", "");
    }, timer);

    const promise = client.executeCommand(["-showBuildSettings"], { timeoutMs: 1234 });
    while (!probeSignal) {
      await Promise.resolve();
    }
    timer.advanceTime(1234);

    await expect(promise).rejects.toThrow(
      "Command timed out after 1234ms: xcodebuild -showBuildSettings",
    );
    expect(probeSignal.aborted).toBe(true);
  });
});

describe("XcodebuildClient streaming runner", () => {
  test("starts a detached argv-form runner without a shell", async () => {
    const child = new FakeChildProcess();
    const calls: Array<{
      command: string;
      args: string[];
      options: import("node:child_process").SpawnOptions;
    }> = [];
    const client = new XcodebuildClient(
      async () => createExecResult("Xcode 26.5", ""),
      new FakeTimer(),
      (command, args, options) => {
        calls.push({ command, args, options });
        child.simulateSpawn();
        return child as never;
      },
    );

    const result = await client.startStreaming(
      ["test-without-building", "-destination", "id=A B"],
      { detached: true, env: { AUTOMOBILE_DEVICE_ID: "A B" }, stdio: ["ignore", "pipe", "pipe"] },
    );

    expect(result).toBe(child);
    expect(calls).toEqual([
      {
        command: "xcodebuild",
        args: ["test-without-building", "-destination", "id=A B"],
        options: {
          detached: true,
          env: { AUTOMOBILE_DEVICE_ID: "A B" },
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        },
      },
    ]);
  });

  test("rejects a streaming runner when xcodebuild is unavailable", async () => {
    const client = new XcodebuildClient(async () => {
      throw new Error("not found");
    });

    await expect(client.startStreaming(["test-without-building"])).rejects.toThrow(
      "xcodebuild is not available",
    );
  });

  test("uses the runner-readiness budget for a no-options availability probe", async () => {
    const timer = new FakeTimer();
    const child = new FakeChildProcess();
    let resolveAvailability: (() => void) | undefined;
    let spawned = false;
    const client = new XcodebuildClient(
      async () =>
        new Promise<ExecResult>((resolve) => {
          resolveAvailability = () => resolve(createExecResult("Xcode 26.5", ""));
        }),
      timer,
      () => {
        spawned = true;
        child.simulateSpawn();
        return child as never;
      },
    );

    const promise = client.startStreaming(["test-without-building"]);
    if (!resolveAvailability) {
      throw new Error("Availability probe did not start");
    }

    timer.advanceTime(5001);
    expect(spawned).toBe(false);
    expect(timer.getPendingTimeouts()).toEqual([DEFAULT_RUNNER_READINESS_TIMEOUT_MS]);

    resolveAvailability();
    await expect(promise).resolves.toBe(child);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("startStreaming releases the availability-probe timer handle", async () => {
    // Covers the SECOND clearTimeout site (isAvailableWithin), independent of
    // executeCommand's: `-version` failing makes the probe resolve unavailable
    // before any spawn, and its timeout must be cleared on the INJECTED timer.
    const timer = new FakeTimer();
    const client = new XcodebuildClient(async () => {
      throw new Error("not found");
    }, timer);

    await expect(
      client.startStreaming(["test-without-building"], { timeoutMs: 5000 }),
    ).rejects.toThrow("xcodebuild is not available");

    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("handles an asynchronous spawn error before returning the child", async () => {
    const timer = new FakeTimer();
    const child = new FakeChildProcess(timer);
    child.setSpawnError("posix_spawn: executable missing");
    const client = new XcodebuildClient(
      async () => createExecResult("Xcode 26.5", ""),
      timer,
      () => {
        child.simulateSpawn();
        return child as never;
      },
    );

    await expect(
      timer.resolvePromise(client.startStreaming(["test-without-building"])),
    ).rejects.toThrow("xcodebuild failed to start: Error: posix_spawn: executable missing");
  });
});
