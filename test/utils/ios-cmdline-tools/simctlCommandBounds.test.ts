import { SimulatorIosInstallBackend } from "../../../src/utils/ios-cmdline-tools/SimulatorIosInstallBackend";
import { describe, expect, test } from "bun:test";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { createExecResult } from "../../../src/utils/execResult";
import type { ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

function stalledClient(timer: FakeTimer) {
  let commandSignal: AbortSignal | undefined;
  const client = new SimCtlClient(
    null,
    async (_file, _args, _buffer, signal) => {
      commandSignal = signal;
      return new Promise<ExecResult>(() => {});
    },
    { timer },
  );
  return { client, signal: () => commandSignal };
}

describe("simctl command bounds under cancellation", () => {
  test.each(["argv", "string", "ambient"])("%s keeps the 60 s cap", async (variant) => {
    const timer = new FakeTimer();
    const { client, signal } = stalledClient(timer);
    const caller = new AbortController();
    const command =
      variant === "argv"
        ? client.executeCommandArgs(["list", "runtimes"], undefined, caller.signal)
        : variant === "string"
          ? client.executeCommand("list runtimes", undefined, caller.signal)
          : runWithAbortSignal(caller.signal, () => client.executeCommand("list runtimes"));
    const outcome = command.catch((error: unknown) => error);
    // This assertion fails immediately on the old code without waiting for a real timeout.
    expect(timer.getPendingTimeouts()).toEqual([60_000]);
    timer.advanceTime(60_000);
    expect(await outcome).toBeInstanceOf(Error);
    expect(String(await outcome)).toContain("Command timed out after 60000ms");
    expect(signal()?.aborted).toBe(true);
  });

  test("caller abort wins even when the exec seam does not settle", async () => {
    const timer = new FakeTimer();
    const { client, signal } = stalledClient(timer);
    const caller = new AbortController();
    const command = client.executeCommandArgs(["list", "runtimes"], undefined, caller.signal);
    const outcome = command.catch((error: unknown) => error);
    expect(timer.getPendingTimeouts()).toEqual([60_000]);
    const reason = new Error("caller cancelled earlier");
    caller.abort(reason);
    // Advancing also guarantees a broken implementation cannot hang this test.
    timer.advanceTime(60_000);
    expect(await outcome).toBe(reason);
    expect(signal()?.aborted).toBe(true);
    expect(timer.getPendingTimeouts()).toEqual([]);
  });

  test("explicit longer timeout lets a long command outlive 60 s", async () => {
    const timer = new FakeTimer();
    const { client } = stalledClient(timer);
    const command = client.executeCommandArgs(
      ["bootstatus", "sim", "-b"],
      180_000,
      new AbortController().signal,
    );
    const outcome = command.catch((error: unknown) => error);
    expect(timer.getPendingTimeouts()).toEqual([180_000]);
    timer.advanceTime(60_000);
    expect(timer.getPendingTimeouts()).toHaveLength(1);
    timer.advanceTime(120_000);
    expect(String(await outcome)).toContain("180000ms");
  });

  test("explicit shorter timeout is honored under a signal", async () => {
    const timer = new FakeTimer();
    const { client } = stalledClient(timer);
    const outcome = client
      .executeCommandArgs(["list", "runtimes"], 25, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(timer.getPendingTimeouts()).toEqual([25]);
    timer.advanceTime(25);
    expect(String(await outcome)).toContain("Command timed out after 25ms");
  });

  test.each(["install", "launch"])("%s has an explicit long-operation bound", async (operation) => {
    const timer = new FakeTimer();
    const { client } = stalledClient(timer);
    const caller = new AbortController();
    const command =
      operation === "install"
        ? runWithAbortSignal(caller.signal, () =>
            new SimulatorIosInstallBackend("sim", client).installApp("app.app"),
          )
        : runWithAbortSignal(caller.signal, () =>
            client.launchApp("com.example.app", undefined, "sim"),
          );
    const outcome = command.catch((error: unknown) => error);
    expect(timer.getPendingTimeouts()).toEqual([180_000]);
    timer.advanceTime(60_000);
    expect(timer.getPendingTimeouts()).toHaveLength(1);
    timer.advanceTime(120_000);
    const result = await outcome;
    if (operation === "install") {
      expect(String(result)).toContain("180000ms");
    } else {
      expect(result).toMatchObject({ success: false, error: expect.stringContaining("180000ms") });
    }
  });

  test("install forwards its signal and explicit timeout", async () => {
    const timer = new FakeTimer();
    let received: AbortSignal | undefined;
    const client = new SimCtlClient(
      null,
      async (_file, _args, _buffer, signal) => {
        received = signal;
        return createExecResult("", "");
      },
      { timer },
    );
    const caller = new AbortController();
    await client.installApp("app.app", "sim", { timeoutMs: 120_000, signal: caller.signal });
    caller.abort();
    expect(received?.aborted).toBe(true);
  });
});
