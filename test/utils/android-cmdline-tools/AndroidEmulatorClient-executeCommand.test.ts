import { describe, expect, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

const createExecResult = (stdout: string, stderr = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (s: string) => stdout.includes(s),
});

// Pin the emulator path so executeCommand builds a deterministic command string
// without touching the filesystem for path detection.
function newClientWithFakeExec(
  execAsync: (file: string, args: string[], signal?: AbortSignal) => Promise<ExecResult>,
  timer: FakeTimer,
): AndroidEmulatorClient {
  const client = new AndroidEmulatorClient(execAsync, null, timer);
  (client as unknown as { emulatorPath: string }).emulatorPath = "emulator";
  (client as unknown as { ensureEmulatorPath: () => Promise<string> }).ensureEmulatorPath =
    async () => "emulator";
  return client;
}

describe("AndroidEmulatorClient executeCommand timeout", () => {
  test("aborts the underlying child process when the command times out", async () => {
    const timer = new FakeTimer();
    let capturedSignal: AbortSignal | undefined;
    let capturedArgs: string[] | undefined;
    const execAsync = async (
      _file: string,
      args: string[],
      signal?: AbortSignal,
    ): Promise<ExecResult> => {
      capturedSignal = signal;
      capturedArgs = args;
      // Simulate a long-running child that only settles when aborted, mirroring
      // execFile rejecting with an AbortError once its signal fires.
      return new Promise<ExecResult>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    };

    const client = newClientWithFakeExec(execAsync, timer);

    const promise = client.executeCommand(["-list-avds"], 1234);
    while (!capturedSignal) {
      await Promise.resolve();
    }
    expect(capturedSignal.aborted).toBe(false);
    // Arguments are forwarded as a literal argv array (no shell).
    expect(capturedArgs).toEqual(["-list-avds"]);

    timer.advanceTime(1234);

    await expect(promise).rejects.toThrow("Command timed out after 1234ms: emulator -list-avds");
    // The timeout must abort the child rather than leave it running orphaned.
    expect(capturedSignal.aborted).toBe(true);
  });

  test("does not abort when the command completes before the timeout", async () => {
    const timer = new FakeTimer();
    let capturedSignal: AbortSignal | undefined;
    const execAsync = async (
      _file: string,
      _args: string[],
      signal?: AbortSignal,
    ): Promise<ExecResult> => {
      capturedSignal = signal;
      return createExecResult("Pixel_9", "");
    };

    const client = newClientWithFakeExec(execAsync, timer);

    const result = await client.executeCommand(["-list-avds"], 5000);

    expect(result.stdout).toBe("Pixel_9");
    expect(capturedSignal?.aborted).toBe(false);
  });

  test("passes each argument literally and no signal when no timeout is specified", async () => {
    const timer = new FakeTimer();
    let capturedFile: string | undefined;
    let capturedArgs: string[] | undefined;
    let capturedSignal: AbortSignal | undefined | "unset" = "unset";
    const execAsync = async (
      file: string,
      args: string[],
      signal?: AbortSignal,
    ): Promise<ExecResult> => {
      capturedFile = file;
      capturedArgs = args;
      capturedSignal = signal;
      return createExecResult("ok", "");
    };

    const client = newClientWithFakeExec(execAsync, timer);

    // An AVD name with a space must survive as a single argv element (a shell
    // would have split it) — the core win of moving off exec.
    const result = await client.executeCommand(["-avd", "My Pixel", "-verbose"]);

    expect(result.stdout).toBe("ok");
    expect(capturedFile).toBe("emulator");
    expect(capturedArgs).toEqual(["-avd", "My Pixel", "-verbose"]);
    expect(capturedSignal).toBeUndefined();
  });

  test("forwards a caller signal to the child when no timeout is specified", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const execAsync = async (
      _file: string,
      _args: string[],
      signal?: AbortSignal,
    ): Promise<ExecResult> => {
      capturedSignal = signal;
      return createExecResult("ok", "");
    };

    const client = newClientWithFakeExec(execAsync, new FakeTimer());
    await client.executeCommand(["-list-avds"], undefined, controller.signal);

    expect(capturedSignal).toBe(controller.signal);
  });

  test("a caller abort reaches the child even while a timeout is armed", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const execAsync = async (
      _file: string,
      _args: string[],
      signal?: AbortSignal,
    ): Promise<ExecResult> => {
      capturedSignal = signal;
      return new Promise<ExecResult>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    };

    const client = newClientWithFakeExec(execAsync, timer);
    const promise = client.executeCommand(["-list-avds"], 5000, controller.signal);
    while (!capturedSignal) {
      await Promise.resolve();
    }
    expect(capturedSignal.aborted).toBe(false);

    controller.abort();

    await expect(promise).rejects.toThrow("aborted");
    expect(capturedSignal.aborted).toBe(true);
    expect(timer.getPendingTimeouts()).toHaveLength(0);
  });

  test("listAvds threads its signal and deadline into the emulator command", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const execAsync = async (
      _file: string,
      _args: string[],
      signal?: AbortSignal,
    ): Promise<ExecResult> => {
      capturedSignal = signal;
      return new Promise<ExecResult>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    };

    const client = newClientWithFakeExec(execAsync, timer);
    const promise = client.listAvds({ signal: controller.signal, timeoutMs: 1234 });
    while (!capturedSignal) {
      await Promise.resolve();
    }

    timer.advanceTime(1234);

    await expect(promise).rejects.toThrow("Command timed out after 1234ms");
    expect(capturedSignal.aborted).toBe(true);
  });
});
