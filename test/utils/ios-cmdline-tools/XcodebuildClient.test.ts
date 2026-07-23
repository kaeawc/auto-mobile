import { describe, expect, test } from "bun:test";
import { XcodebuildClient } from "../../../src/utils/ios-cmdline-tools/XcodebuildClient";
import type { ExecResult } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
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
      signal?: AbortSignal
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
      "Command timed out after 1234ms: xcodebuild -showBuildSettings"
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
      signal?: AbortSignal
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
      "Command timed out after 1234ms: xcodebuild -showBuildSettings"
    );
    expect(probeSignal.aborted).toBe(true);
  });
});

describe("XcodebuildClient streaming runner", () => {
  test("starts a detached argv-form runner without a shell", async () => {
    const child = new FakeChildProcess();
    const calls: Array<{ command: string; args: string[]; options: import("node:child_process").SpawnOptions }> = [];
    const client = new XcodebuildClient(
      async () => createExecResult("Xcode 26.5", ""),
      new FakeTimer(),
      (command, args, options) => {
        calls.push({ command, args, options });
        return child as never;
      }
    );

    const result = await client.startStreaming(
      ["test-without-building", "-destination", "id=A B"],
      { detached: true, env: { AUTOMOBILE_DEVICE_ID: "A B" }, stdio: ["ignore", "pipe", "pipe"] }
    );

    expect(result).toBe(child);
    expect(calls).toEqual([{
      command: "xcodebuild",
      args: ["test-without-building", "-destination", "id=A B"],
      options: {
        detached: true,
        env: { AUTOMOBILE_DEVICE_ID: "A B" },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      }
    }]);
  });

  test("rejects a streaming runner when xcodebuild is unavailable", async () => {
    const client = new XcodebuildClient(async () => {
      throw new Error("not found");
    });

    await expect(client.startStreaming(["test-without-building"])).rejects.toThrow(
      "xcodebuild is not available"
    );
  });
});
