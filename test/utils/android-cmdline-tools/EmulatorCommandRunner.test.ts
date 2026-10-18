import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/models";
import { DefaultEmulatorCommandRunner } from "../../../src/utils/android-cmdline-tools/EmulatorCommandRunner";
import { FakeTimer } from "../../fakes/FakeTimer";

function execResult(stdout = ""): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (value) => stdout.includes(value),
  };
}

type Exec = (file: string, args: string[], signal?: AbortSignal) => Promise<ExecResult>;

function runner(exec: Exec) {
  const timer = new FakeTimer();
  const calls: { file: string; args: string[]; signal?: AbortSignal }[] = [];
  const subject = new DefaultEmulatorCommandRunner({
    timer: () => timer,
    ensureEmulatorPath: async () => "/sdk/emulator",
    execAsync: (file, args, signal) => {
      calls.push({ file, args, signal });
      return exec(file, args, signal);
    },
  });
  return { subject, timer, calls };
}

describe("DefaultEmulatorCommandRunner", () => {
  test("runs the located emulator binary with the caller's signal when no timeout is set", async () => {
    const controller = new AbortController();
    const { subject, calls } = runner(async () => execResult("avd1"));
    const result = await subject.executeCommand(["-list-avds"], undefined, controller.signal);
    expect(result.stdout).toBe("avd1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("/sdk/emulator");
    expect(calls[0]?.args).toEqual(["-list-avds"]);
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  test("resolves with the result when the command beats its deadline", async () => {
    const { subject } = runner(async () => execResult("ok"));
    expect((await subject.executeCommand(["-version"], 5_000)).stdout).toBe("ok");
  });

  test("a command past its deadline fails with a timeout error and aborts the child", async () => {
    const { subject, timer, calls } = runner(() => new Promise<ExecResult>(() => {}));
    const pending = subject.executeCommand(["-list-avds"], 1_000);
    const failure = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await Promise.resolve();
    await Promise.resolve();
    timer.advanceTime(1_000);
    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Command timed out after 1000ms: /sdk/emulator -list-avds",
    );
    expect(calls[0]?.signal?.aborted).toBe(true);
  });
});
