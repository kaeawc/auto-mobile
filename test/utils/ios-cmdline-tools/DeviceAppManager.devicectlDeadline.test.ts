import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/models";
import { ActionableError } from "../../../src/models/ActionableError";
import { wrapCommandError } from "../../../src/utils/CommandError";
import { createExecResult } from "../../../src/utils/execResult";
import type { HostCommandOptions } from "../../../src/utils/HostCommandExecutor";
import {
  DeviceAppManager,
  SIMULATOR_APP_CONTAINER_TIMEOUT_MS,
  SIMULATOR_UNINSTALL_TIMEOUT_MS,
} from "../../../src/utils/ios-cmdline-tools/DeviceAppManager";
import { SimctlCommandTimeoutError } from "../../../src/utils/ios-cmdline-tools/SimctlCommandTimeoutError";
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
    });
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
    });
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
  });

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
  });

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
  });

  test("prompt normal result is unchanged and clears the backstop", async () => {
    const result = createExecResult("", "");
    const { manager, timer, events } = harness(async () => result);
    const pending = manager["execute"]("xcrun", ["devicectl", "--version"]);
    expect(timer.getPendingTimeouts()).toEqual([20_000]);
    expect(await pending).toBe(result);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(events).toEqual([]);
  });

  for (const command of [
    { file: "xcrun", args: ["simctl", "uninstall", "udid", "com.example.app"] },
    { file: "another-tool", args: ["devicectl", "--version"] },
  ]) {
    test(`${command.file} ${command.args[0]} gets no defaults or backstop`, async () => {
      const { manager, calls, timer } = harness();
      await manager["execute"](command.file, command.args);
      expect(calls[0]?.options).toBeUndefined();
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });
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
  });

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
  });
});

describe("DeviceAppManager simulator uninstall bound (issue #10077)", () => {
  const udid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";

  test("bounds simctl uninstall with a timeout, a kill signal and the request signal", async () => {
    const { manager, calls } = harness();
    const controller = new AbortController();

    await manager.uninstallApp(udid, "com.example.app", true, { signal: controller.signal });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["simctl", "uninstall", udid, "com.example.app"]);
    expect(calls[0]?.options).toEqual({
      timeoutMs: SIMULATOR_UNINSTALL_TIMEOUT_MS,
      killSignal: "SIGKILL",
      signal: controller.signal,
    });
  });

  test("still bounds simctl uninstall when no request signal exists", async () => {
    const { manager, calls } = harness();

    await manager.uninstallApp(udid, "com.example.app", true);

    expect(calls[0]?.options).toEqual({
      timeoutMs: SIMULATOR_UNINSTALL_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  });

  test("a timed-out uninstall is indeterminate, not a plain failure", async () => {
    const timeout = wrapCommandError(
      Object.assign(new Error("node timeout"), { killed: true, signal: "SIGKILL" }),
      { command: "xcrun" },
    );
    const { manager, events } = harness(async () => {
      throw timeout;
    });

    const error = await manager.uninstallApp(udid, "com.example.app", true).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(error).toHaveProperty("message", expect.stringContaining("indeterminate"));
    expect(error).toHaveProperty("message", expect.stringContaining("com.example.app"));
    expect(error).toHaveProperty("message", expect.stringContaining("Do not retry automatically"));
    expect(error).toHaveProperty("cause", timeout);
    expect(events).toHaveLength(1);
  });

  test("a cancelled uninstall propagates the cancellation, not an indeterminate error", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Cancelled by caller", "AbortError");
    const killed = wrapCommandError(Object.assign(new Error("aborted"), { killed: true }), {
      command: "xcrun",
    });
    const { manager, events } = harness(async () => {
      controller.abort(reason);
      throw killed;
    });

    await expect(
      manager.uninstallApp(udid, "com.example.app", true, { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(events).toEqual([]);
  });

  test("a non-timeout uninstall failure passes through unchanged", async () => {
    const failure = wrapCommandError(Object.assign(new Error("not found"), { code: 1 }), {
      command: "xcrun",
    });
    const { manager, events } = harness(async () => {
      throw failure;
    });

    await expect(manager.uninstallApp(udid, "com.example.app", true)).rejects.toBe(failure);
    expect(events).toEqual([]);
  });
});

describe("DeviceAppManager simulator app-container lookup bound", () => {
  const udid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
  const bundleId = "com.example.app";

  test("bounds simctl get_app_container with a timeout, a kill signal and the request signal", async () => {
    const { manager, calls } = harness();
    const controller = new AbortController();

    // An empty container path means "no bundle to hash", so no filesystem read happens.
    const hash = await manager.getInstalledAppBundleHash(udid, bundleId, true, {
      signal: controller.signal,
    });

    expect(hash).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["simctl", "get_app_container", udid, bundleId, "app"]);
    expect(calls[0]?.options).toEqual({
      timeoutMs: SIMULATOR_APP_CONTAINER_TIMEOUT_MS,
      killSignal: "SIGKILL",
      signal: controller.signal,
    });
  });

  test("still bounds the lookup when no request signal exists", async () => {
    const { manager, calls } = harness();

    await manager.getInstalledAppBundleHash(udid, bundleId, true);

    expect(calls[0]?.options).toEqual({
      timeoutMs: SIMULATOR_APP_CONTAINER_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  });

  test("a timed-out lookup keeps the null-on-failure contract and logs a warning", async () => {
    const timeout = wrapCommandError(Object.assign(new Error("node timeout"), { killed: true }), {
      command: "xcrun",
    });
    const { manager, events } = harness(async () => {
      throw timeout;
    });

    expect(await manager.getInstalledAppBundleHash(udid, bundleId, true)).toBeNull();
    expect(events).toHaveLength(1);
  });

  test("a timed-out lookup throws the typed timeout when the caller opts in", async () => {
    const timeout = wrapCommandError(Object.assign(new Error("node timeout"), { killed: true }), {
      command: "xcrun",
    });
    const { manager } = harness(async () => {
      throw timeout;
    });

    const failure = await manager
      .getInstalledAppBundleHash(udid, bundleId, true, { throwOnLookupTimeout: true })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(SimctlCommandTimeoutError);
    expect(failure).toHaveProperty("cause", timeout);
  });

  test("opting in does not turn a plain missing-app failure into a timeout", async () => {
    const missing = wrapCommandError(Object.assign(new Error("not found"), { code: 2 }), {
      command: "xcrun",
    });
    const { manager } = harness(async () => {
      throw missing;
    });

    expect(
      await manager.getInstalledAppBundleHash(udid, bundleId, true, {
        throwOnLookupTimeout: true,
      }),
    ).toBeNull();
  });

  test("a cancelled lookup propagates the cancellation instead of reading as 'not installed'", async () => {
    const controller = new AbortController();
    const killed = wrapCommandError(Object.assign(new Error("aborted"), { killed: true }), {
      command: "xcrun",
    });
    const { manager, events } = harness(async () => {
      controller.abort();
      throw killed;
    });

    await expect(
      manager.getInstalledAppBundleHash(udid, bundleId, true, { signal: controller.signal }),
    ).rejects.toThrow("Operation cancelled");
    expect(events).toEqual([]);
  });
});
