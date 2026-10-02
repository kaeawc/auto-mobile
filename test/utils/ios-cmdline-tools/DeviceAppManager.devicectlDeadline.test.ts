import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/models";
import { ActionableError } from "../../../src/models/ActionableError";
import { wrapCommandError } from "../../../src/utils/CommandError";
import { createExecResult } from "../../../src/utils/execResult";
import type { HostCommandOptions } from "../../../src/utils/HostCommandExecutor";
import { DeviceAppManager } from "../../../src/utils/ios-cmdline-tools/DeviceAppManager";
import { FakeTimer } from "../../fakes/FakeTimer";

type Execute = NonNullable<ConstructorParameters<typeof DeviceAppManager>[0]>["execute"];

function harness(execute: Execute = async () => createExecResult("", "")) {
  const timer = new FakeTimer();
  const calls: { file: string; args: string[]; options?: HostCommandOptions }[] = [];
  const events: string[] = [];
  const manager = new DeviceAppManager({
    platform: () => "darwin",
    execute: (file, args, options) => {
      calls.push({ file, args, options });
      return execute(file, args, options);
    },
    readFile: async () => {
      throw new Error("Deadline tests must not read command JSON");
    },
    mkdtemp: async () => "/fake/devicectl-deadline",
    rm: async () => undefined,
    readdir: async () => [],
    stat: async () => ({ isDirectory: () => false }),
    tmpdir: () => "/fake",
    logger: { debug: () => undefined, warn: (message) => events.push(message) },
    timer,
  });
  return { manager, timer, calls, events };
}

describe("DeviceAppManager devicectl deadlines", () => {
  for (const operation of [
    {
      name: "install",
      deadline: 180_000,
      command: "xcrun devicectl device install app",
      invoke: (manager: DeviceAppManager) => manager.installApp("private-udid", "/private/App.ipa"),
    },
    {
      name: "version",
      deadline: 15_000,
      command: "xcrun devicectl --version",
      invoke: (manager: DeviceAppManager) => manager.getDevicectlVersion(),
    },
  ]) {
    test(`abandons a never-settling ${operation.name} after the deadline and grace`, async () => {
      const { manager, timer, events } = harness(() => new Promise<ExecResult>(() => {}));
      const pending = operation.invoke(manager).then(
        () => new Error("Unexpected success"),
        (error: unknown) => {
          events.push("rejected");
          return error;
        },
      );
      // Fail promptly against the old implementation instead of waiting on its hung promise.
      expect(timer.getPendingTimeouts()).toEqual([operation.deadline + 5_000]);
      timer.advanceTime(operation.deadline + 4_999);
      await Promise.resolve();
      expect(events).toEqual([]);
      expect(timer.getPendingTimeoutCount()).toBe(1);
      timer.advanceTime(1);
      const error = await pending;
      expect(error).toBeInstanceOf(ActionableError);
      expect(error).toHaveProperty("message", expect.stringContaining(operation.command));
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining(`timed out after ${operation.deadline} ms`),
      );
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining("device may be locked or unpaired"),
      );
      expect(error).toHaveProperty("message", expect.stringContaining("Unlock"));
      expect(error).toHaveProperty("message", expect.stringContaining("trust"));
      expect(error).toHaveProperty("message", expect.stringContaining("cable"));
      expect(events).toHaveLength(2);
      expect(events[0]).toContain(operation.command);
      expect(events[1]).toBe("rejected");
      expect(events[0]).not.toContain("private-udid");
      expect(events[0]).not.toContain("/private/App.ipa");
      expect(timer.getPendingTimeoutCount()).toBe(0);
    }, 100);
  }

  for (const operation of [
    { args: ["devicectl", "--version"], deadline: 15_000 },
    { args: ["devicectl", "device", "info", "apps"], deadline: 15_000 },
    { args: ["devicectl", "device", "info", "processes"], deadline: 15_000 },
    { args: ["devicectl", "device", "info", "details"], deadline: 15_000 },
    { args: ["devicectl", "list", "devices"], deadline: 15_000 },
    { args: ["devicectl", "device", "install", "app"], deadline: 180_000 },
    { args: ["devicectl", "device", "copy", "from"], deadline: 180_000 },
    { args: ["devicectl", "device", "uninstall", "app"], deadline: 60_000 },
    { args: ["devicectl", "device", "process", "launch"], deadline: 60_000 },
    { args: ["devicectl", "device", "process", "terminate"], deadline: 60_000 },
    { args: ["devicectl", "future-command"], deadline: 60_000 },
  ]) {
    test(`defaults ${operation.args.join(" ")} to ${operation.deadline} ms and SIGKILL`, async () => {
      const { manager, calls, timer } = harness();
      // Exercise the shared private seam without widening the production API or casting.
      await manager["execute"]("xcrun", operation.args, { cwd: "/fake", maxBuffer: 42 });
      expect(calls).toEqual([
        {
          file: "xcrun",
          args: operation.args,
          options: {
            cwd: "/fake",
            maxBuffer: 42,
            timeoutMs: operation.deadline,
            killSignal: "SIGKILL",
          },
        },
      ]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    }, 100);
  }

  test("public install, uninstall and payload launch use their class defaults", async () => {
    const { manager, calls, timer } = harness();
    await manager.installApp("udid", "/fake/App.ipa");
    await manager.uninstallApp("udid", "com.example.app");
    await manager.launchWithPayloadUrl("udid", "com.example.app", "example://home");
    expect(calls.map((call) => call.options)).toEqual([
      { timeoutMs: 180_000, killSignal: "SIGKILL" },
      { timeoutMs: 60_000, killSignal: "SIGKILL" },
      { signal: undefined, timeoutMs: 60_000, killSignal: "SIGKILL" },
    ]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  }, 100);

  test("caller signal bypasses defaults and backstop, and still aborts", async () => {
    const controller = new AbortController();
    const { manager, timer, calls, events } = harness(
      (_file, _args, options) =>
        new Promise<ExecResult>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = manager.launchWithPayloadUrl(
      "udid",
      "com.example.app",
      "example://home",
      controller.signal,
    );
    expect(calls[0]?.options).toEqual({ signal: controller.signal });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    const reason = new DOMException("Cancelled by caller", "AbortError");
    controller.abort(reason);
    await expect(pending).rejects.toThrow("Operation cancelled");
    expect(events).toEqual([]);
  }, 100);

  test("caller timeout wins, preserving its kill signal and failure", async () => {
    const failure = wrapCommandError(Object.assign(new Error("caller timeout"), { killed: true }), {
      command: "xcrun",
    });
    const { manager, calls, timer, events } = harness(async () => {
      throw failure;
    });
    const options = { timeoutMs: 123, killSignal: "SIGTERM" } satisfies HostCommandOptions;
    await expect(manager["execute"]("xcrun", ["devicectl", "--version"], options)).rejects.toBe(
      failure,
    );
    expect(calls[0]?.options).toBe(options);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(events).toEqual([]);
  }, 100);

  test("prompt normal result is unchanged and clears the backstop", async () => {
    const result = createExecResult("", "");
    const { manager, timer, events } = harness(async () => result);
    const pending = manager["execute"]("xcrun", ["devicectl", "--version"]);
    expect(timer.getPendingTimeouts()).toEqual([20_000]);
    expect(await pending).toBe(result);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(events).toEqual([]);
  }, 100);

  for (const command of [
    { file: "xcrun", args: ["simctl", "uninstall", "udid", "com.example.app"] },
    { file: "another-tool", args: ["devicectl", "--version"] },
  ]) {
    test(`${command.file} ${command.args[0]} gets no defaults or backstop`, async () => {
      const { manager, calls, timer } = harness();
      await manager["execute"](command.file, command.args);
      expect(calls[0]?.options).toBeUndefined();
      expect(timer.getPendingTimeoutCount()).toBe(0);
    }, 100);
  }

  test("wrapped node timeout becomes an actionable deadline failure after warning", async () => {
    const original = Object.assign(new Error("node timeout"), { killed: true, signal: "SIGTERM" });
    const failure = wrapCommandError(original, {
      command: "xcrun",
      args: ["devicectl", "--version"],
    });
    const { manager, events, timer } = harness(async () => {
      throw failure;
    });
    const error = await manager.getDevicectlVersion().then(
      () => undefined,
      (error: unknown) => {
        events.push("rejected");
        return error;
      },
    );
    expect(error).toBeInstanceOf(ActionableError);
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining("xcrun devicectl --version timed out after 15000 ms"),
    );
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining("device may be locked or unpaired"),
    );
    expect(error).toHaveProperty("cause", failure);
    expect(events).toHaveLength(2);
    expect(events[0]).toContain("timed out");
    expect(events[1]).toBe("rejected");
    expect(timer.getPendingTimeoutCount()).toBe(0);
  }, 100);

  test("non-timeout exec failure passes through unchanged", async () => {
    const original = Object.assign(new Error("permission denied"), {
      code: 1,
      stderr: "device unavailable",
    });
    const failure = wrapCommandError(original, { command: "xcrun" });
    const { manager, events, timer } = harness(async () => {
      throw failure;
    });
    await expect(manager.getDevicectlVersion()).rejects.toBe(failure);
    expect(events).toEqual([]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  }, 100);
});
