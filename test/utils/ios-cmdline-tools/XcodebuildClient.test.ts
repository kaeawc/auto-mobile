import { describe, expect, test } from "bun:test";
import { XcodebuildClient } from "../../../src/utils/ios-cmdline-tools/XcodebuildClient";
import type { ExecResult } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";

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
});
