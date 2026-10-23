import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/models";
import { ActionableError } from "../../../src/models/ActionableError";
import { PhysicalIosAppCrasher } from "../../../src/utils/ios-cmdline-tools/PhysicalIosAppCrasher";
import {
  PhysicalIosCrashBackend,
  SimulatorIosCrashBackend,
  resolveIosCrashBackend,
  type SimulatorCrashCommandRunner,
} from "../../../src/utils/ios-cmdline-tools/IosCrashBackend";

const simulatorUdid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
const serviceLabel = "UIKitApplication:com.example.app[abcd][1234]";
const unsupportedMessage =
  "crashApp is not supported on physical iOS devices; " +
  "AutoMobile will not fall back to normal termination";

class FakeCrashCommandRunner implements SimulatorCrashCommandRunner {
  readonly calls: Array<{ args: string[]; timeoutMs?: number; signal?: AbortSignal }> = [];
  readonly result: ExecResult = {
    stdout: "output",
    stderr: "",
    toString: () => "output",
    trim: () => "output",
    includes: (search) => "output".includes(search),
  };
  error?: Error;

  async executeCommandArgs(
    args: string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    this.calls.push({ args: [...args], timeoutMs, signal });
    if (this.error) {
      throw this.error;
    }
    return this.result;
  }
}

describe("IosCrashBackend", () => {
  test("simulator lists processes with exact argv, timeout and signal", async () => {
    const runner = new FakeCrashCommandRunner();
    const backend = new SimulatorIosCrashBackend(simulatorUdid, runner);
    const signal = new AbortController().signal;

    expect(await backend.listProcesses({ timeoutMs: 5_000, signal })).toBe(runner.result);
    expect(runner.calls).toEqual([
      { args: ["spawn", simulatorUdid, "launchctl", "list"], timeoutMs: 5_000, signal },
    ]);
    expect(runner.calls[0].signal).toBe(signal);
  });

  test("simulator dispatches SIGKILL when the caller asks for it (#14098)", async () => {
    const runner = new FakeCrashCommandRunner();
    const backend = new SimulatorIosCrashBackend(simulatorUdid, runner);

    await backend.killProcess({ serviceLabel, uid: 502, timeoutMs: 5_000, signalName: "SIGKILL" });

    expect(runner.calls[0].args).toEqual([
      "spawn",
      simulatorUdid,
      "launchctl",
      "kill",
      "SIGKILL",
      `user/502/${serviceLabel}`,
    ]);
  });

  test("simulator dispatches SIGABRT with the supplied uid and service label", async () => {
    const runner = new FakeCrashCommandRunner();
    const backend = new SimulatorIosCrashBackend(simulatorUdid, runner);
    const signal = new AbortController().signal;

    expect(await backend.killProcess({ serviceLabel, uid: 502, timeoutMs: 15_000, signal })).toBe(
      runner.result,
    );
    expect(runner.calls).toEqual([
      {
        args: ["spawn", simulatorUdid, "launchctl", "kill", "SIGABRT", `user/502/${serviceLabel}`],
        timeoutMs: 15_000,
        signal,
      },
    ]);
    expect(runner.calls[0].signal).toBe(signal);
  });

  test("simulator reads crash logs with the unchanged predicate and options", async () => {
    const runner = new FakeCrashCommandRunner();
    const backend = new SimulatorIosCrashBackend(simulatorUdid, runner);
    const signal = new AbortController().signal;

    expect(await backend.readCrashLog({ timeoutMs: 2_000, signal })).toBe(runner.result);
    expect(runner.calls).toEqual([
      {
        args: [
          "spawn",
          simulatorUdid,
          "log",
          "show",
          "--last",
          "1m",
          "--style",
          "compact",
          "--timezone",
          "UTC",
          "--predicate",
          'eventMessage CONTAINS[c] "SIGABRT"',
        ],
        timeoutMs: 2_000,
        signal,
      },
    ]);
    expect(runner.calls[0].signal).toBe(signal);
  });

  test("simulator preserves runner errors and omitted signals", async () => {
    const runner = new FakeCrashCommandRunner();
    const backend = new SimulatorIosCrashBackend(simulatorUdid, runner);
    runner.error = new Error("simctl failed");

    await expect(backend.listProcesses({ timeoutMs: 123 })).rejects.toBe(runner.error);
    await expect(backend.killProcess({ serviceLabel, uid: 501, timeoutMs: 456 })).rejects.toBe(
      runner.error,
    );
    await expect(backend.readCrashLog({ timeoutMs: 789 })).rejects.toBe(runner.error);
    expect(runner.calls.map(({ timeoutMs, signal }) => ({ timeoutMs, signal }))).toEqual([
      { timeoutMs: 123, signal: undefined },
      { timeoutMs: 456, signal: undefined },
      { timeoutMs: 789, signal: undefined },
    ]);
  });

  test("physical operations reject with the actionable unsupported error", async () => {
    const runner = new FakeCrashCommandRunner();
    const backend = resolveIosCrashBackend("00008030-001C2D3E1234567A", { simctl: runner });
    const options = { timeoutMs: 5_000 };

    for (const operation of [
      () => backend.listProcesses(options),
      () => backend.killProcess({ ...options, serviceLabel, uid: 501 }),
      () => backend.readCrashLog(options),
    ]) {
      await expect(operation()).rejects.toBeInstanceOf(ActionableError);
      await expect(operation()).rejects.toThrow(unsupportedMessage);
    }
    expect(runner.calls).toEqual([]);
  });

  test.each([
    [simulatorUdid, "simulator"],
    ["00008030-001C2D3E1234567A", "physical"],
    ["0123456789abcdef0123456789abcdef01234567", "physical"],
    ["unknown-device", "physical"],
  ] as const)("resolver selects %s as %s without dispatch", (deviceId, kind) => {
    const runner = new FakeCrashCommandRunner();
    const backend = resolveIosCrashBackend(deviceId, { simctl: runner });

    expect(backend.kind).toBe(kind);
    expect(backend).toBeInstanceOf(
      kind === "simulator" ? SimulatorIosCrashBackend : PhysicalIosCrashBackend,
    );
    expect(runner.calls).toEqual([]);
  });
});

describe("PhysicalIosAppCrasher (#14096)", () => {
  const deviceUdid = "00008110-0012345678901234";

  test("binds DeviceAppManager's PID lookup and SIGABRT to one device", async () => {
    const calls: unknown[][] = [];
    const crasher = new PhysicalIosAppCrasher(deviceUdid, {
      findRunningAppPid: async (udid, bundleId) => {
        calls.push(["find", udid, bundleId]);
        return 4321;
      },
      signalProcess: async (udid, pid, signal) => {
        calls.push(["signal", udid, pid, signal]);
        return "already_exited";
      },
    });

    expect(await crasher.findAppPid("com.example.app")).toBe(4321);
    expect(await crasher.sendAbort(4321)).toBe("already_exited");
    expect(calls).toEqual([
      ["find", deviceUdid, "com.example.app"],
      ["signal", deviceUdid, 4321, "SIGABRT"],
    ]);
  });

  test("sendKill binds SIGKILL to the device and honors cancellation (#14098)", async () => {
    const calls: unknown[][] = [];
    const crasher = new PhysicalIosAppCrasher(deviceUdid, {
      findRunningAppPid: async () => 4321,
      signalProcess: async (udid, pid, signal) => {
        calls.push(["signal", udid, pid, signal]);
        return "signalled";
      },
    });

    expect(await crasher.sendKill(4321)).toBe("signalled");
    expect(calls).toEqual([["signal", deviceUdid, 4321, "SIGKILL"]]);

    const controller = new AbortController();
    controller.abort();
    await expect(crasher.sendKill(4321, { signal: controller.signal })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test("a cancelled request never sends the signal", async () => {
    let signalled = false;
    const crasher = new PhysicalIosAppCrasher(deviceUdid, {
      findRunningAppPid: async () => 4321,
      signalProcess: async () => {
        signalled = true;
        return "signalled";
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(crasher.sendAbort(4321, { signal: controller.signal })).rejects.toThrow();
    expect(signalled).toBe(false);
  });
});
