import { expect, describe, test, beforeEach } from "bun:test";
import { Simctl } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { BootedDevice, ExecResult } from "../../../src/models";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createExecResult } from "../../../src/utils/execResult";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../../src/utils/deviceTimeouts";

function resetSimctlCaches(): void {
  const simctlClass = Simctl as unknown as {
    deviceListCache: { devices: unknown[]; timestamp: number } | null;
    lastGoodDeviceList: { devices: unknown[]; timestamp: number } | null;
    inFlightDeviceList: Promise<unknown[]> | null;
    simulatorBoots: Map<string, unknown>;
  };
  simctlClass.deviceListCache = null;
  simctlClass.lastGoodDeviceList = null;
  simctlClass.inFlightDeviceList = null;
  simctlClass.simulatorBoots.clear();
}

async function waitForCondition(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt++) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function simulatorListPayload(devices: unknown[]): string {
  return JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-4": devices,
    },
    runtimes: [],
    devicetypes: [],
    pairs: [],
  });
}

function bootedListPayload(udid: string): string {
  return simulatorListPayload([{ udid, name: "iPhone 17", state: "Booted", isAvailable: true }]);
}

describe("Simctl", function () {
  let simctl: Simctl;
  let mockDevice: BootedDevice;
  let mockExecAsync: (
    file: string,
    args: string[],
    maxBuffer?: number,
    signal?: AbortSignal,
  ) => Promise<ExecResult>;

  beforeEach(function () {
    resetSimctlCaches();

    mockDevice = {
      deviceId: "test-ios-device-id",
      name: "Test iOS Device",
      platform: "ios",
      source: "local",
    };

    mockExecAsync = async (): Promise<ExecResult> => {
      return {
        stdout: "",
        stderr: "",
        toString: () => "",
        trim: () => "",
        includes: () => false,
      };
    };

    simctl = new Simctl(mockDevice, mockExecAsync);
  });

  describe("isAvailable", function () {
    test("should return true when simctl is available", async function () {
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "--find simctl") {
          return createExecResult("/Applications/Xcode.app/usr/bin/simctl\n", "");
        }
        throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
      };

      simctl = new Simctl(null, mockExecAsync);

      const available = await simctl.isAvailable();
      expect(available).toBe(true);
    });

    test("should return false when simctl is not available", async function () {
      mockExecAsync = async (): Promise<ExecResult> => {
        throw new Error("Command not found: xcrun");
      };

      simctl = new Simctl(null, mockExecAsync);

      const available = await simctl.isAvailable();
      expect(available).toBe(false);
    });

    test("checks tool resolution without masking a device-health command error", async function () {
      const commands: string[] = [];
      mockExecAsync = async (_file: string, args: string[]): Promise<ExecResult> => {
        commands.push(args.join(" "));
        if (args.join(" ") === "--find simctl") {
          return createExecResult("/Applications/Xcode.app/usr/bin/simctl\n", "");
        }
        throw new Error("Unable to boot device in current state: Shutdown");
      };
      simctl = new Simctl(null, mockExecAsync);

      await expect(simctl.isAvailable()).resolves.toBe(true);
      await expect(simctl.executeCommandArgs(["boot", "test-ios-device-id"])).rejects.toThrow(
        "Unable to boot device in current state: Shutdown",
      );
      expect(commands).toEqual(["--find simctl", "simctl boot test-ios-device-id"]);
    });

    test("bounds and aborts a stalled tool-resolution check", async function () {
      const timer = new FakeTimer();
      let probeSignal: AbortSignal | undefined;
      mockExecAsync = async (
        _file: string,
        _args: string[],
        _maxBuffer?: number,
        signal?: AbortSignal,
      ): Promise<ExecResult> => {
        probeSignal = signal;
        return new Promise<ExecResult>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("probe aborted")));
        });
      };
      simctl = new Simctl(null, mockExecAsync, timer);

      const caller = new AbortController();
      const availability = simctl.isAvailable({ timeoutMs: 123, signal: caller.signal });
      expect(probeSignal?.aborted).toBe(false);
      expect(timer.getPendingTimeouts()).toEqual([123]);
      timer.advanceTime(123);

      await expect(availability).resolves.toBe(false);
      expect(probeSignal?.aborted).toBe(true);
    });
  });

  describe("executeCommand", function () {
    test("dispatches a simctl command once without a version preflight", async function () {
      const commands: Array<{ file: string; args: string[] }> = [];
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        commands.push({ file, args });
        return createExecResult("command executed", "");
      };

      simctl = new Simctl(mockDevice, mockExecAsync);
      await simctl.executeCommand("list devices");

      expect(commands).toEqual([{ file: "xcrun", args: ["simctl", "list", "devices"] }]);
    });

    test("maps a missing simctl utility to actionable Xcode guidance", async function () {
      mockExecAsync = async (): Promise<ExecResult> => {
        throw new Error('xcrun: error: unable to find utility "simctl", not a developer tool');
      };
      simctl = new Simctl(mockDevice, mockExecAsync, undefined, "darwin");

      await expect(simctl.executeCommandArgs(["list", "devices"])).rejects.toThrow(
        "Please install Xcode command line tools",
      );
    });

    test("should execute pre-split simctl arguments without dropping empty strings or backslashes", async function () {
      let executedFile = "";
      let executedArgs: string[] = [];
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        executedFile = file;
        executedArgs = args;
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1.0.0", "");
        }
        return createExecResult("command executed", "");
      };

      simctl = new Simctl(mockDevice, mockExecAsync);
      await simctl.executeCommandArgs([
        "spawn",
        "test-ios-device-id",
        "defaults",
        "write",
        "com.example.app",
        "windowsPath",
        "-string",
        "C:\\tmp",
        "",
      ]);

      expect(executedFile).toBe("xcrun");
      expect(executedArgs).toEqual([
        "simctl",
        "spawn",
        "test-ios-device-id",
        "defaults",
        "write",
        "com.example.app",
        "windowsPath",
        "-string",
        "C:\\tmp",
        "",
      ]);
    });
  });

  describe("startCommandArgs", function () {
    test("starts a supervised simctl command with literal argv", async function () {
      const started: { command?: string; args?: readonly string[]; options?: SpawnOptions } = {};
      const child = {} as ChildProcess;
      let execCalls = 0;
      mockExecAsync = async (): Promise<ExecResult> => {
        execCalls += 1;
        return createExecResult("", "");
      };
      simctl = new Simctl(
        mockDevice,
        mockExecAsync,
        undefined,
        undefined,
        (command, args, options) => {
          started.command = command;
          started.args = args;
          started.options = options;
          return child;
        },
      );

      const result = await simctl.startCommandArgs(
        ["io", "test-ios-device-id", "recordVideo", "/tmp/a path;$(safe).mov"],
        { stdio: ["ignore", "ignore", "pipe"] },
      );

      expect(result).toBe(child);
      expect(started.command).toBe("xcrun");
      expect(started.args).toEqual([
        "simctl",
        "io",
        "test-ios-device-id",
        "recordVideo",
        "/tmp/a path;$(safe).mov",
      ]);
      expect(started.options).toEqual({ stdio: ["ignore", "ignore", "pipe"] });
      expect(execCalls).toBe(0);
    });
  });

  describe("startSimulator", function () {
    test("uses bootstatus -b instead of raw boot so already-booted simulators are accepted", async function () {
      const commands: string[][] = [];
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        commands.push([file, ...args]);
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1.0.0", "");
        }
        if (file === "xcrun" && args.join(" ") === "simctl boot test-ios-device-id") {
          throw new Error("raw boot should not be called");
        }
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          // Boot is self-verifying: it requires the device to actually be Booted.
          return createExecResult(
            JSON.stringify({
              devices: {
                "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
                  {
                    udid: "test-ios-device-id",
                    name: "iPhone 17",
                    state: "Booted",
                    isAvailable: true,
                  },
                ],
              },
            }),
            "",
          );
        }
        return createExecResult("command executed", "");
      };

      simctl = new Simctl(mockDevice, mockExecAsync);

      const childProcess = await simctl.startSimulator("test-ios-device-id");

      expect(childProcess.exitCode).toBe(0);
      expect(commands).toContainEqual([
        "xcrun",
        "simctl",
        "bootstatus",
        "test-ios-device-id",
        "-b",
      ]);
      expect(commands).not.toContainEqual(["xcrun", "simctl", "boot", "test-ios-device-id"]);
    });

    test("applies timeout to the bootstatus wait", async function () {
      const timer = new FakeTimer();
      let resolveCommand: ((result: ExecResult) => void) | undefined;
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1.0.0", "");
        }
        if (file === "xcrun" && args.join(" ") === "simctl shutdown test-ios-device-id") {
          return createExecResult("", "");
        }
        return new Promise<ExecResult>((resolve) => {
          resolveCommand = resolve;
        });
      };

      simctl = new Simctl(mockDevice, mockExecAsync, timer);

      const bootPromise = simctl.startSimulator("test-ios-device-id", 1234);
      await waitForCondition(() => resolveCommand !== undefined, "boot command dispatch");
      timer.advanceTime(1234);

      await expect(bootPromise).rejects.toThrow(
        "Command timed out after 1234ms: xcrun simctl bootstatus test-ios-device-id -b",
      );
      resolveCommand?.(createExecResult("late bootstatus", ""));
    });

    test("applies the default timeout to the bootstatus wait", async function () {
      const timer = new FakeTimer();
      let resolveCommand: ((result: ExecResult) => void) | undefined;
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1.0.0", "");
        }
        if (file === "xcrun" && args.join(" ") === "simctl shutdown test-ios-device-id") {
          return createExecResult("", "");
        }
        return new Promise<ExecResult>((resolve) => {
          resolveCommand = resolve;
        });
      };

      simctl = new Simctl(mockDevice, mockExecAsync, timer);

      const bootPromise = simctl.startSimulator("test-ios-device-id");
      await waitForCondition(() => resolveCommand !== undefined, "boot command dispatch");
      timer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS);

      await expect(bootPromise).rejects.toThrow(
        `Command timed out after ${DEFAULT_DEVICE_READY_TIMEOUT_MS}ms: xcrun simctl bootstatus test-ios-device-id -b`,
      );
      resolveCommand?.(createExecResult("late bootstatus", ""));
    });

    test("aborts the underlying child process when the bootstatus wait times out", async function () {
      const timer = new FakeTimer();
      let capturedSignal: AbortSignal | undefined;
      mockExecAsync = async (
        file: string,
        args: string[],
        _maxBuffer?: number,
        signal?: AbortSignal,
      ): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1.0.0", "");
        }
        if (file === "xcrun" && args.join(" ") === "simctl shutdown test-ios-device-id") {
          return createExecResult("", "");
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

      simctl = new Simctl(mockDevice, mockExecAsync, timer);

      const bootPromise = simctl.startSimulator("test-ios-device-id", 1234);
      await waitForCondition(() => capturedSignal !== undefined, "boot abort signal");
      expect(capturedSignal.aborted).toBe(false);

      timer.advanceTime(1234);

      await expect(bootPromise).rejects.toThrow(
        "Command timed out after 1234ms: xcrun simctl bootstatus test-ios-device-id -b",
      );
      // The timeout must abort the child rather than leave it running orphaned.
      expect(capturedSignal.aborted).toBe(true);
    });
  });

  describe("startSimulator returned handle", function () {
    test("does not fabricate a pid (no real OS process backs a synchronous bootstatus)", async function () {
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1.0.0", "");
        }
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          return createExecResult(bootedListPayload("iphone-udid"), "");
        }
        return createExecResult("", "");
      };
      simctl = new Simctl(mockDevice, mockExecAsync);

      const handle = await simctl.startSimulator("iphone-udid");

      // AC3: honest handle — no fabricated timestamp pid.
      expect(handle.pid).toBeUndefined();
    });

    test("kill() shuts the simulator back down instead of being a no-op", async function () {
      const commands: string[][] = [];
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        commands.push([file, ...args]);
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1.0.0", "");
        }
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          return createExecResult(bootedListPayload("iphone-udid"), "");
        }
        return createExecResult("", "");
      };
      simctl = new Simctl(mockDevice, mockExecAsync);

      const handle = await simctl.startSimulator("iphone-udid");

      // AC1: kill() reports success and issues `simctl shutdown <udid>` rather
      // than the previous no-op `() => false`.
      expect(handle.kill()).toBe(true);
      for (let i = 0; i < 25 && !commands.some((c) => c.includes("shutdown")); i++) {
        await Promise.resolve();
      }
      expect(commands).toContainEqual(["xcrun", "simctl", "shutdown", "iphone-udid"]);
    });
  });

  describe("waitForSimulatorReady", function () {
    const readyPayload = simulatorListPayload([
      {
        udid: "iphone-17-pro-udid",
        name: "iPhone 17 Pro",
        state: "Booted",
        isAvailable: true,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
        os_version: "26.4",
      },
    ]);

    function recordingReadyExec(commands: string[][]): typeof mockExecAsync {
      return async (file: string, args: string[]): Promise<ExecResult> => {
        commands.push([file, ...args]);
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1.0.0", "");
        }
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          return createExecResult(readyPayload, "");
        }
        return createExecResult("", "");
      };
    }

    test("runs bootstatus -b on the already-running path (no assumeBooted)", async function () {
      const commands: string[][] = [];
      simctl = new Simctl(mockDevice, recordingReadyExec(commands));

      const device = await simctl.waitForSimulatorReady("iphone-17-pro-udid");

      expect(device.deviceId).toBe("iphone-17-pro-udid");
      expect(commands).toContainEqual([
        "xcrun",
        "simctl",
        "bootstatus",
        "iphone-17-pro-udid",
        "-b",
      ]);
    });

    test("skips the redundant bootstatus -b when assumeBooted is set (cold-boot path)", async function () {
      const commands: string[][] = [];
      simctl = new Simctl(mockDevice, recordingReadyExec(commands));

      const device = await simctl.waitForSimulatorReady("iphone-17-pro-udid", 1234, {
        assumeBooted: true,
      });

      expect(device.deviceId).toBe("iphone-17-pro-udid");
      // The cold-boot path already waited via startSimulator; no second boot wait.
      expect(commands.some((c) => c.includes("bootstatus"))).toBe(false);
    });
  });

  describe("listSimulatorImages", function () {
    test("runs discovery directly without a tool-resolution preflight", async function () {
      const commands: string[] = [];
      const payload = simulatorListPayload([
        {
          udid: "iphone-17-pro-udid",
          name: "iPhone 17 Pro",
          state: "Booted",
          isAvailable: true,
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
          os_version: "26.4",
        },
      ]);

      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        commands.push(`${file} ${args.join(" ")}`);
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          return createExecResult(payload, "");
        }
        throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
      };

      simctl = new Simctl(null, mockExecAsync, undefined, "darwin");

      const devices = await simctl.listSimulatorImages();

      expect(devices.map((device) => device.name)).toEqual(["iPhone 17 Pro"]);
      expect(devices[0]?.capabilityInventory).toEqual({
        schemaVersion: 1,
        capabilities: [
          { id: "ios.simulator.biometric", state: "available", source: "platform" },
          {
            id: "ios.simulator.nfc",
            state: "unsupported",
            source: "platform",
            reason: "iOS Simulator cannot emulate NFC hardware.",
          },
        ],
      });
      expect(commands).toEqual(["xcrun simctl list devices --json"]);
    });

    test("should not cache an empty simulator discovery result", async function () {
      const timer = new FakeTimer();
      let listCalls = 0;
      const emptyPayload = simulatorListPayload([]);
      const populatedPayload = simulatorListPayload([
        {
          udid: "iphone-17-pro-udid",
          name: "iPhone 17 Pro",
          state: "Booted",
          isAvailable: true,
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
          os_version: "26.4",
        },
      ]);

      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1051.50", "");
        }
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          listCalls++;
          return createExecResult(listCalls === 1 ? emptyPayload : populatedPayload, "");
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync, timer);

      expect(await simctl.listSimulatorImages()).toEqual([]);
      const devices = await simctl.listSimulatorImages();

      expect(listCalls).toBe(2);
      expect(devices.map((device) => device.name)).toEqual(["iPhone 17 Pro"]);
    });

    test("invalidates the simulator discovery cache after deletion", async function () {
      let listCalls = 0;
      const existingSimulatorPayload = simulatorListPayload([
        {
          udid: "test-ios-device-id",
          name: "iPhone 17",
          state: "Shutdown",
          isAvailable: true,
        },
      ]);
      const deletedSimulatorPayload = simulatorListPayload([]);

      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1051.50", "");
        }
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          listCalls++;
          return createExecResult(
            listCalls === 1 ? existingSimulatorPayload : deletedSimulatorPayload,
            "",
          );
        }
        if (file === "xcrun" && args.join(" ") === "simctl delete test-ios-device-id") {
          return createExecResult("", "");
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync);

      expect((await simctl.listSimulatorImages()).map((device) => device.deviceId)).toEqual([
        "test-ios-device-id",
      ]);

      await simctl.deleteSimulator("test-ios-device-id");

      expect(await simctl.listSimulatorImages()).toEqual([]);
      expect(listCalls).toBe(2);
    });

    test("waits for a timed-out delete command to settle before releasing coordination", async function () {
      const timer = new FakeTimer();
      let deleteSignal: AbortSignal | undefined;
      let settleDelete!: (result: ExecResult) => void;
      mockExecAsync = async (
        file: string,
        args: string[],
        _maxBuffer?: number,
        signal?: AbortSignal,
      ): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1051.50", "");
        }
        if (file === "xcrun" && args.join(" ") === "simctl delete test-ios-device-id") {
          deleteSignal = signal;
          return await new Promise<ExecResult>((resolve) => {
            settleDelete = resolve;
          });
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync, timer);
      let settled = false;
      const deletion = simctl
        .deleteSimulator("test-ios-device-id", { timeoutMs: 10 })
        .finally(() => {
          settled = true;
        });
      await waitForCondition(() => deleteSignal !== undefined, "delete abort signal");

      timer.advanceTime(10);
      await Promise.resolve();
      expect(deleteSignal.aborted).toBe(true);
      expect(settled).toBe(false);

      settleDelete(createExecResult("", ""));
      await expect(deletion).rejects.toThrow(
        "Command timed out after 10ms: xcrun simctl delete test-ios-device-id",
      );
    });

    test("bounds an unsettled delete command with the default timeout", async function () {
      const timer = new FakeTimer();
      let deleteSignal: AbortSignal | undefined;
      mockExecAsync = async (
        file: string,
        args: string[],
        _maxBuffer?: number,
        signal?: AbortSignal,
      ): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1051.50", "");
        }
        if (file === "xcrun" && args.join(" ") === "simctl delete test-ios-device-id") {
          deleteSignal = signal;
          return await new Promise<ExecResult>(() => {});
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync, timer);
      const deletion = simctl.deleteSimulator("test-ios-device-id");
      const deletionOutcome = deletion.then(
        () => undefined,
        (error: unknown) => error,
      );
      await waitForCondition(() => deleteSignal !== undefined, "delete abort signal");
      expect(deleteSignal?.aborted).toBe(false);

      timer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS);
      for (let attempt = 0; attempt < 50 && timer.getPendingTimeoutCount() === 0; attempt++) {
        await Promise.resolve();
      }
      expect(deleteSignal?.aborted).toBe(true);
      expect(timer.getPendingTimeoutCount()).toBe(1);
      timer.advanceTime(1_000);

      const deletionError = await deletionOutcome;
      expect(deletionError).toBeInstanceOf(Error);
      expect((deletionError as Error).message).toBe(
        `Command timed out after ${DEFAULT_DEVICE_READY_TIMEOUT_MS}ms: xcrun simctl delete test-ios-device-id`,
      );
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });

    test("waits for a timed-out shutdown command to settle", async function () {
      const timer = new FakeTimer();
      let shutdownSignal: AbortSignal | undefined;
      let settleShutdown!: (result: ExecResult) => void;
      mockExecAsync = async (
        file: string,
        args: string[],
        _maxBuffer?: number,
        signal?: AbortSignal,
      ): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1051.50", "");
        }
        if (file === "xcrun" && args.join(" ") === "simctl shutdown test-ios-device-id") {
          shutdownSignal = signal;
          return await new Promise<ExecResult>((resolve) => {
            settleShutdown = resolve;
          });
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync, timer);
      let settled = false;
      const shutdown = simctl
        .killSimulator(
          {
            platform: "ios",
            name: "iPhone 17",
            deviceId: "test-ios-device-id",
          },
          { timeoutMs: 10 },
        )
        .finally(() => {
          settled = true;
        });
      await waitForCondition(() => shutdownSignal !== undefined, "shutdown abort signal");

      timer.advanceTime(10);
      await Promise.resolve();
      expect(shutdownSignal.aborted).toBe(true);
      expect(settled).toBe(false);

      settleShutdown(createExecResult("", ""));
      await expect(shutdown).rejects.toThrow(
        "Command timed out after 10ms: xcrun simctl shutdown test-ios-device-id",
      );
    });

    test("bypasses the simulator discovery cache when requested", async function () {
      let listCalls = 0;
      const firstPayload = simulatorListPayload([
        {
          udid: "test-ios-device-id",
          name: "iPhone 17",
          state: "Shutdown",
          isAvailable: true,
        },
      ]);
      const secondPayload = simulatorListPayload([]);

      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1051.50", "");
        }
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          listCalls++;
          return createExecResult(listCalls === 1 ? firstPayload : secondPayload, "");
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync);

      expect(await simctl.listSimulatorImages()).toHaveLength(1);
      expect(await simctl.listSimulatorImages(undefined, { bypassCache: true })).toEqual([]);
      expect(listCalls).toBe(2);
    });

    test("should surface simctl discovery failures instead of returning an empty list", async function () {
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1051.50", "");
        }
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          throw new Error("simctl list devices exploded");
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync);

      await expect(simctl.listSimulatorImages()).rejects.toThrow(
        /Failed to list iOS simulator devices.*simctl list devices exploded/,
      );
    });

    test("should include unavailable and transitional simulators", async function () {
      const simulatorPayload = {
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-17-4": [
            {
              udid: "booted-udid",
              name: "iPhone 15 Pro",
              state: "Booted",
              isAvailable: true,
              deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro",
              os_version: "17.4",
              model: "iPhone15,3",
              architecture: "arm64",
            },
            {
              udid: "shutdown-udid",
              name: "iPhone 15",
              state: "Shutdown",
              isAvailable: true,
              deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
              os_version: "17.4",
            },
            {
              udid: "creating-udid",
              name: "iPhone 14",
              state: "Creating",
              isAvailable: true,
              deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-14",
              os_version: "17.4",
            },
            {
              udid: "unavailable-udid",
              name: "iPhone 13",
              state: "Unavailable",
              isAvailable: false,
              availabilityError: "runtime missing",
              deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-13",
            },
          ],
        },
        runtimes: [],
        devicetypes: [],
        pairs: [],
      };

      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return {
            stdout: "simctl version 1.0.0",
            stderr: "",
            toString: () => "simctl version 1.0.0",
            trim: () => "simctl version 1.0.0",
            includes: () => false,
          };
        }
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          const payload = JSON.stringify(simulatorPayload);
          return {
            stdout: payload,
            stderr: "",
            toString: () => payload,
            trim: () => payload.trim(),
            includes: (search: string) => payload.includes(search),
          };
        }
        return {
          stdout: "",
          stderr: "",
          toString: () => "",
          trim: () => "",
          includes: () => false,
        };
      };

      simctl = new Simctl(null, mockExecAsync);

      const devices = await simctl.listSimulatorImages();

      expect(devices).toHaveLength(4);
      const unavailable = devices.find((device) => device.deviceId === "unavailable-udid");
      expect(unavailable?.state).toBe("Unavailable");
      expect(unavailable?.isAvailable).toBe(false);
      expect(unavailable?.availabilityError).toBe("runtime missing");
      expect(unavailable?.runtime).toBe("com.apple.CoreSimulator.SimRuntime.iOS-17-4");
      expect(unavailable?.iosVersion).toBe("17.4");
    });

    test("coalesces concurrent calls with a cold cache onto one simctl invocation", async function () {
      let listCalls = 0;
      let resolveList!: (payload: string) => void;
      const payload = simulatorListPayload([
        { udid: "test-ios-device-id", name: "iPhone 17", state: "Booted", isAvailable: true },
      ]);

      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          listCalls++;
          return await new Promise<ExecResult>((resolve) => {
            resolveList = (stdout: string) => resolve(createExecResult(stdout, ""));
          });
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync);

      const first = simctl.listSimulatorImages();
      const second = simctl.getBootedSimulatorsChecked();
      const third = simctl.getBootedSimulatorsChecked();

      await waitForCondition(() => resolveList !== undefined, "simctl list invocation");
      resolveList(payload);

      const [firstDevices, secondDevices] = await Promise.all([first, second, third]);
      expect(listCalls).toBe(1);
      expect(firstDevices.map((device) => device.deviceId)).toEqual(["test-ios-device-id"]);
      expect(secondDevices.map((device) => device.deviceId)).toEqual(["test-ios-device-id"]);
    });

    test("successful shutdown invalidates the cached boot state", async function () {
      const timer = new FakeTimer();
      let running = true;
      let reads = 0;
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          reads++;
          return createExecResult(
            simulatorListPayload([
              {
                udid: "test-ios-device-id",
                name: "iPhone 17",
                state: running ? "Booted" : "Shutdown",
                isAvailable: true,
              },
            ]),
            "",
          );
        }
        if (args.includes("shutdown")) {
          running = false;
        }
        return createExecResult("", "");
      };
      simctl = new Simctl(null, mockExecAsync, timer);
      expect(await simctl.getBootedSimulatorsChecked()).toHaveLength(1);
      await simctl.killSimulator({
        deviceId: "test-ios-device-id",
        platform: "ios",
        name: "iPhone 17",
      });
      expect(await simctl.getBootedSimulatorsChecked()).toEqual([]);
      expect(reads).toBe(2);
      expect(timer.now()).toBe(0);
    });

    test("getBootedSimulatorsChecked reuses a fresh listSimulatorImages cache within the TTL", async function () {
      const timer = new FakeTimer();
      let listCalls = 0;
      const payload = simulatorListPayload([
        { udid: "test-ios-device-id", name: "iPhone 17", state: "Booted", isAvailable: true },
      ]);

      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          listCalls++;
          return createExecResult(payload, "");
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync, timer);

      await simctl.listSimulatorImages();
      expect(listCalls).toBe(1);

      const booted = await simctl.getBootedSimulatorsChecked();
      expect(listCalls).toBe(1);
      expect(booted.map((device) => device.deviceId)).toEqual(["test-ios-device-id"]);
    });

    test("returns the last-good device list instead of throwing on a transient discovery failure", async function () {
      const timer = new FakeTimer();
      let listCalls = 0;
      const payload = simulatorListPayload([
        { udid: "test-ios-device-id", name: "iPhone 17", state: "Booted", isAvailable: true },
      ]);

      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          listCalls++;
          if (listCalls === 2) {
            throw new Error("simctl list devices exploded");
          }
          return createExecResult(payload, "");
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync, timer);

      const firstDevices = await simctl.listSimulatorImages();
      expect(firstDevices.map((device) => device.deviceId)).toEqual(["test-ios-device-id"]);

      // Expire the TTL cache so the next call re-invokes simctl, which fails.
      timer.advanceTime(6_000);

      const fallbackDevices = await simctl.listSimulatorImages();
      expect(listCalls).toBe(2);
      expect(fallbackDevices.map((device) => device.deviceId)).toEqual(["test-ios-device-id"]);
    });

    test("an authoritative empty listing also clears the last-good snapshot", async function () {
      const timer = new FakeTimer();
      let listCalls = 0;
      const withDevice = simulatorListPayload([
        { udid: "test-ios-device-id", name: "iPhone 17", state: "Booted", isAvailable: true },
      ]);
      const empty = simulatorListPayload([]);

      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          listCalls++;
          if (listCalls === 1) {
            return createExecResult(withDevice, "");
          }
          if (listCalls === 2) {
            return createExecResult(empty, "");
          }
          throw new Error("simctl list devices exploded");
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync, timer);

      expect(await simctl.listSimulatorImages()).toHaveLength(1);

      // Expire the TTL cache so the next call re-invokes simctl with an
      // authoritative empty result.
      timer.advanceTime(6_000);
      expect(await simctl.listSimulatorImages()).toEqual([]);

      // Expire the TTL cache again so the third call fails and falls back to
      // the last-good snapshot -- which must now be empty, not the stale
      // one-device snapshot from before the authoritative empty listing.
      timer.advanceTime(6_000);
      const fallbackDevices = await simctl.listSimulatorImages();
      expect(listCalls).toBe(3);
      expect(fallbackDevices).toEqual([]);
    });

    test("an in-flight listing started before an invalidation must not repopulate the cache", async function () {
      let listCalls = 0;
      let resolveList!: (payload: string) => void;
      const payload = bootedListPayload("test-ios-device-id");

      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          listCalls++;
          return await new Promise<ExecResult>((resolve) => {
            resolveList = (stdout: string) => resolve(createExecResult(stdout, ""));
          });
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync);

      const inFlight = simctl.listSimulatorImages();
      await waitForCondition(() => resolveList !== undefined, "in-flight simctl listing");

      // A create/delete (or an explicit reset) invalidates the cache while the
      // above listing -- captured under the OLD generation -- is still pending.
      Simctl.invalidateDeviceListCache();
      resolveList(payload);

      await expect(inFlight).resolves.toHaveLength(1);
      expect(listCalls).toBe(1);

      const simctlClass = Simctl as unknown as {
        deviceListCache: { devices: unknown[]; timestamp: number } | null;
        lastGoodDeviceList: { devices: unknown[]; timestamp: number } | null;
      };
      expect(simctlClass.deviceListCache).toBeNull();
      expect(simctlClass.lastGoodDeviceList).toBeNull();

      // The stale-generation resolution must not have satisfied the cache: the
      // next call re-invokes simctl instead of trusting a phantom cache entry.
      let resolveNext!: (payload: string) => void;
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          listCalls++;
          return await new Promise<ExecResult>((resolve) => {
            resolveNext = (stdout: string) => resolve(createExecResult(stdout, ""));
          });
        }
        return createExecResult("", "");
      };
      simctl = new Simctl(null, mockExecAsync);
      const next = simctl.listSimulatorImages();
      await waitForCondition(() => resolveNext !== undefined, "post-invalidation simctl listing");
      resolveNext(payload);
      await expect(next).resolves.toHaveLength(1);
      expect(listCalls).toBe(2);
    });

    test("coalesces concurrent callers but bounds each to its own deadline", async function () {
      let listCalls = 0;
      let resolveList!: (payload: string) => void;
      const payload = bootedListPayload("test-ios-device-id");

      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          listCalls++;
          return await new Promise<ExecResult>((resolve) => {
            resolveList = (stdout: string) => resolve(createExecResult(stdout, ""));
          });
        }
        return createExecResult("", "");
      };

      const timer = new FakeTimer();
      simctl = new Simctl(null, mockExecAsync, timer);

      // Caller A is unbounded; caller B bounds itself to 100ms. Both must
      // collapse onto the same shared `simctl list devices` invocation.
      const callerA = simctl.listSimulatorImages();
      const callerB = simctl.listSimulatorImages(100).catch((error: unknown) => error);
      await waitForCondition(() => resolveList !== undefined, "shared simctl invocation");
      expect(listCalls).toBe(1);

      // Caller B's own deadline elapses while the shared fetch is still
      // pending; this must reject ONLY caller B, not the shared fetch.
      timer.advanceTime(100);
      const callerBOutcome = await callerB;
      expect(callerBOutcome).toBeInstanceOf(Error);
      expect((callerBOutcome as Error).message).toContain("Timed out waiting for iOS simulator");

      // The shared fetch is unaffected by caller B's timeout: resolving it now
      // still satisfies caller A.
      resolveList(payload);
      const callerADevices = await callerA;
      expect(callerADevices.map((device) => device.deviceId)).toEqual(["test-ios-device-id"]);
      expect(listCalls).toBe(1);
    });

    test("aborting one coalesced caller does not reject the others", async function () {
      let listCalls = 0;
      let resolveList!: (payload: string) => void;
      const payload = bootedListPayload("test-ios-device-id");

      mockExecAsync = async (
        file: string,
        args: string[],
        _maxBuffer?: number,
        signal?: AbortSignal,
      ): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          listCalls++;
          return await new Promise<ExecResult>((resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            resolveList = (stdout: string) => resolve(createExecResult(stdout, ""));
          });
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync);

      const controllerA = new AbortController();
      const callerA = runWithAbortSignal(controllerA.signal, () =>
        simctl.listSimulatorImages(),
      ).catch((error: unknown) => error);
      const callerB = simctl.listSimulatorImages();
      await waitForCondition(() => resolveList !== undefined, "shared simctl invocation");
      expect(listCalls).toBe(1);

      controllerA.abort(new Error("caller A cancelled"));
      const callerAOutcome = await callerA;
      expect(callerAOutcome).toBeInstanceOf(Error);
      expect((callerAOutcome as Error).message).toBe("caller A cancelled");

      // Caller B must still resolve from the shared fetch, unaffected by A's
      // abort.
      resolveList(payload);
      const callerBDevices = await callerB;
      expect(callerBDevices.map((device) => device.deviceId)).toEqual(["test-ios-device-id"]);
      expect(listCalls).toBe(1);
    });

    test.each([false, true])(
      "invalidated flights cannot disturb replacement (old failure: %s)",
      async function (failOld) {
        const requests: Array<{
          resolve: (value: ExecResult) => void;
          reject: (error: Error) => void;
        }> = [];
        mockExecAsync = async (_file, args) => {
          if (args.join(" ") !== "simctl list devices --json") {
            return createExecResult("", "");
          }
          return new Promise<ExecResult>((resolve, reject) => {
            requests.push({ resolve, reject });
          });
        };
        simctl = new Simctl(null, mockExecAsync, new FakeTimer());
        const old = simctl.listSimulatorImages().catch(() => []);
        await waitForCondition(() => requests.length === 1, "old listing");
        Simctl.invalidateDeviceListCache();
        const fresh = simctl.listSimulatorImages();
        await waitForCondition(() => requests.length === 2, "new listing");
        if (failOld) {
          requests[1].resolve(createExecResult(bootedListPayload("new"), ""));
          await fresh;
          requests[0].reject(new Error("obsolete failure"));
          await old;
        } else {
          requests[0].resolve(createExecResult(bootedListPayload("old"), ""));
          await old;
          const joined = simctl.listSimulatorImages();
          requests[1].resolve(createExecResult(bootedListPayload("new"), ""));
          await joined;
        }
        expect((await simctl.listSimulatorImages())[0].deviceId).toBe("new");
        expect(requests).toHaveLength(2);
      },
    );

    test.each([false, true])(
      "bypass refresh supersedes older snapshots (empty: %s)",
      async function (empty) {
        const timer = new FakeTimer();
        let calls = 0;
        let oldResolve!: (value: ExecResult) => void;
        mockExecAsync = async (_file, args) => {
          if (args.join(" ") !== "simctl list devices --json") {
            return createExecResult("", "");
          }
          calls++;
          if (calls === 1) {
            return new Promise<ExecResult>((resolve) => {
              oldResolve = resolve;
            });
          }
          if (calls === 2) {
            return createExecResult(
              empty ? simulatorListPayload([]) : bootedListPayload("new"),
              "",
            );
          }
          throw new Error("transient failure");
        };
        simctl = new Simctl(null, mockExecAsync, timer);
        const old = simctl.listSimulatorImages();
        await waitForCondition(() => oldResolve !== undefined, "old listing");
        const fresh = await simctl.listSimulatorImages(undefined, { bypassCache: true });
        oldResolve(createExecResult(bootedListPayload("old"), ""));
        await old;
        timer.advanceTime(6000);
        expect(await simctl.listSimulatorImages()).toEqual(fresh);
        expect(fresh.map((device) => device.deviceId)).toEqual(empty ? [] : ["new"]);
      },
    );

    test("a failed bypass refresh must not discard a shared flight that succeeded with newer data", async function () {
      const timer = new FakeTimer();
      let calls = 0;
      let sharedResolve!: (value: ExecResult) => void;
      let bypassReject!: (error: Error) => void;
      mockExecAsync = async (_file, args) => {
        if (args.join(" ") !== "simctl list devices --json") {
          return createExecResult("", "");
        }
        calls++;
        if (calls === 1) {
          // The ordinary shared flight -- left pending so the bypass below can
          // start concurrently.
          return new Promise<ExecResult>((resolve) => {
            sharedResolve = resolve;
          });
        }
        if (calls === 2) {
          // The bypass refresh -- also left pending so it can be failed AFTER
          // the shared flight above has already resolved successfully.
          return new Promise<ExecResult>((_resolve, reject) => {
            bypassReject = reject;
          });
        }
        throw new Error("simctl list devices exploded");
      };
      simctl = new Simctl(null, mockExecAsync, timer);

      const shared = simctl.listSimulatorImages();
      await waitForCondition(() => sharedResolve !== undefined, "shared listing");
      const bypass = simctl
        .listSimulatorImages(undefined, { bypassCache: true })
        .catch((error: unknown) => error);
      await waitForCondition(() => bypassReject !== undefined, "bypass listing");

      // The shared flight succeeds with genuinely newer data while the bypass
      // is still in flight.
      sharedResolve(createExecResult(bootedListPayload("newer"), ""));
      await expect(shared).resolves.toHaveLength(1);

      // The bypass then fails -- it never produced an authoritative result, so
      // it must not have superseded the shared flight's successful snapshot.
      bypassReject(new Error("bypass discovery failed"));
      expect(await bypass).toBeInstanceOf(Error);

      // Expire the TTL cache so the next call re-invokes simctl and fails,
      // forcing a fallback to the last-good snapshot -- which must be the
      // shared flight's successful "newer" data, not stale/missing data
      // discarded because of the bypass's failed attempt.
      timer.advanceTime(6000);
      const fallback = await simctl.listSimulatorImages();
      expect(calls).toBe(3);
      expect(fallback.map((device) => device.deviceId)).toEqual(["newer"]);
    });

    test("an explicit bypass signal cancels the underlying discovery", async function () {
      let captured: AbortSignal | undefined;
      mockExecAsync = async (_file, args, _maxBuffer, signal) => {
        if (args.join(" ") !== "simctl list devices --json") {
          return createExecResult("", "");
        }
        captured = signal;
        return new Promise<ExecResult>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      };
      simctl = new Simctl(null, mockExecAsync, new FakeTimer());
      const controller = new AbortController();
      const result = simctl
        .listSimulatorImages(undefined, { bypassCache: true, signal: controller.signal })
        .catch((error: unknown) => error);
      await waitForCondition(() => captured !== undefined, "bypass discovery");
      const reason = new Error("bypass cancelled");
      controller.abort(reason);
      expect(await result).toBe(reason);
      expect(captured?.aborted).toBe(true);
    });

    test("getBootedSimulatorsChecked throws on an already-aborted signal even on a fresh cache hit", async function () {
      const payload = bootedListPayload("test-ios-device-id");
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          return createExecResult(payload, "");
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync);

      // Populate a fresh (within-TTL) cache entry.
      expect(await simctl.listSimulatorImages()).toHaveLength(1);

      const controller = new AbortController();
      controller.abort(new Error("caller aborted"));

      await expect(simctl.getBootedSimulatorsChecked(undefined, controller.signal)).rejects.toThrow(
        "caller aborted",
      );
    });
  });

  describe("getRuntimes uses dedicated simctl command", function () {
    test("should return runtimes from simctl list runtimes --json", async function () {
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl list runtimes --json") {
          return createExecResult(
            JSON.stringify({
              runtimes: [
                {
                  bundlePath:
                    "/Library/Developer/CoreSimulator/Volumes/iOS_26.2/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.2.simruntime",
                  identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-2",
                  isAvailable: true,
                  name: "iOS 26.2",
                  version: "26.2",
                },
                {
                  bundlePath:
                    "/Library/Developer/CoreSimulator/Volumes/iOS_18.6/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 18.6.simruntime",
                  identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
                  isAvailable: false,
                  name: "iOS 18.6",
                  version: "18.6",
                },
              ],
            }),
            "",
          );
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync);
      const runtimes = await simctl.getRuntimes();
      expect(runtimes).toHaveLength(1);
      expect(runtimes[0].name).toBe("iOS 26.2");
      expect(runtimes[0].isAvailable).toBe(true);
    });

    test("surfaces the runtimes command error", async function () {
      mockExecAsync = async (_file: string, args: string[]): Promise<ExecResult> => {
        if (args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 0.0", "");
        }
        throw new Error("simctl list runtimes exploded");
      };

      simctl = new Simctl(null, mockExecAsync);
      await expect(simctl.getRuntimes()).rejects.toThrow("simctl list runtimes exploded");
    });

    // ADD (#4177 item 3): malformed simctl output must degrade to "no runtimes"
    // via the catch, and a valid payload that simply omits the `runtimes` key
    // must degrade via `data.runtimes ?? []` — a different branch (SimCtlClient
    // :1119) that no test pinned. A regression in either would silently report
    // zero installed runtimes with no error.
    test("returns an empty list when the runtimes JSON is malformed (swallow)", async function () {
      mockExecAsync = async (_file: string, args: string[]): Promise<ExecResult> => {
        if (args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 0.0", "");
        }
        return createExecResult("this is not { valid json", "");
      };

      simctl = new Simctl(null, mockExecAsync);
      expect(await simctl.getRuntimes()).toEqual([]);
    });

    test("returns an empty list when the runtimes key is absent (data.runtimes ?? [])", async function () {
      mockExecAsync = async (_file: string, args: string[]): Promise<ExecResult> => {
        if (args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 0.0", "");
        }
        return createExecResult(JSON.stringify({ notRuntimes: [] }), "");
      };

      simctl = new Simctl(null, mockExecAsync);
      expect(await simctl.getRuntimes()).toEqual([]);
    });
  });

  describe("getDeviceTypes uses dedicated simctl command", function () {
    test("should return device types from simctl list devicetypes --json", async function () {
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl list devicetypes --json") {
          return createExecResult(
            JSON.stringify({
              devicetypes: [
                {
                  name: "iPhone 17 Pro",
                  identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
                  bundlePath:
                    "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone 17 Pro.simdevicetype",
                },
              ],
            }),
            "",
          );
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync);
      const types = await simctl.getDeviceTypes();
      expect(types).toHaveLength(1);
      expect(types[0].name).toBe("iPhone 17 Pro");
    });

    test("surfaces the devicetypes command error", async function () {
      mockExecAsync = async (_file: string, args: string[]): Promise<ExecResult> => {
        if (args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 0.0", "");
        }
        throw new Error("simctl list devicetypes exploded");
      };

      simctl = new Simctl(null, mockExecAsync);
      await expect(simctl.getDeviceTypes()).rejects.toThrow("simctl list devicetypes exploded");
    });

    // ADD (#4177 item 3): malformed / key-absent payloads degrade to [].
    test("returns an empty list when the devicetypes JSON is malformed (swallow)", async function () {
      mockExecAsync = async (_file: string, args: string[]): Promise<ExecResult> => {
        if (args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 0.0", "");
        }
        return createExecResult("<<< not json >>>", "");
      };

      simctl = new Simctl(null, mockExecAsync);
      expect(await simctl.getDeviceTypes()).toEqual([]);
    });

    test("returns an empty list when the devicetypes key is absent (data.devicetypes ?? [])", async function () {
      mockExecAsync = async (_file: string, args: string[]): Promise<ExecResult> => {
        if (args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 0.0", "");
        }
        return createExecResult(JSON.stringify({ somethingElse: 1 }), "");
      };

      simctl = new Simctl(null, mockExecAsync);
      expect(await simctl.getDeviceTypes()).toEqual([]);
    });
  });

  describe("openSimulatorApp headless detection", function () {
    const HEADLESS_ENV = "AUTOMOBILE_IOS_HEADLESS";
    let savedEnv: string | undefined;
    let calls: Array<{ file: string; args: string[] }>;

    function recordingExec(managerName: string | Error = "Aqua"): typeof mockExecAsync {
      return async (file: string, args: string[]): Promise<ExecResult> => {
        calls.push({ file, args });
        if (file === "launchctl" && args[0] === "managername") {
          if (managerName instanceof Error) {
            throw managerName;
          }
          return createExecResult(`${managerName}\n`, "");
        }
        return createExecResult("", "");
      };
    }

    function openCalls(): Array<{ file: string; args: string[] }> {
      return calls.filter(
        (c) => c.file === "open" && c.args[0] === "-a" && c.args[1] === "Simulator",
      );
    }

    function launchctlCalls(): Array<{ file: string; args: string[] }> {
      return calls.filter((c) => c.file === "launchctl" && c.args[0] === "managername");
    }

    beforeEach(function () {
      savedEnv = process.env[HEADLESS_ENV];
      delete process.env[HEADLESS_ENV];
      calls = [];
    });

    function restoreEnv(): void {
      if (savedEnv === undefined) {
        delete process.env[HEADLESS_ENV];
      } else {
        process.env[HEADLESS_ENV] = savedEnv;
      }
    }

    // Decision table (#4177 item 4 / PARAM-1). Resolution order that MUST hold:
    //   1. A non-darwin host can never launch Simulator.app, so it is headless
    //      regardless of the override — this gate must come BEFORE the override
    //      is consumed, otherwise AUTOMOBILE_IOS_HEADLESS=false (or "") would
    //      shell `open -a Simulator` on Linux/Windows (the bug this pins).
    //   2. On darwin, the env override short-circuits the launchctl probe:
    //      "true"/"1" ⇒ headless (skip), anything else defined ⇒ force GUI.
    //   3. With no override on darwin, probe launchctl: "Aqua" ⇒ GUI, otherwise
    //      headless; a probe failure falls back to GUI.
    // expectedProbes is the launchctl-probe count; the override path must never
    // probe (short-circuit), so an override row always expects 0 probes.
    type Manager = "Aqua" | "System" | Error;
    const headlessRows: ReadonlyArray<{
      override: string | undefined;
      platform: NodeJS.Platform;
      manager: Manager;
      expectedOpens: number;
      expectedProbes: number;
    }> = [
      // darwin, no override → launchctl decides
      {
        override: undefined,
        platform: "darwin",
        manager: "Aqua",
        expectedOpens: 1,
        expectedProbes: 1,
      },
      {
        override: undefined,
        platform: "darwin",
        manager: "System",
        expectedOpens: 0,
        expectedProbes: 1,
      },
      {
        override: undefined,
        platform: "darwin",
        manager: new Error("launchctl unavailable"),
        expectedOpens: 1,
        expectedProbes: 1,
      },
      // darwin, override short-circuits the probe
      {
        override: "true",
        platform: "darwin",
        manager: "Aqua",
        expectedOpens: 0,
        expectedProbes: 0,
      },
      { override: "1", platform: "darwin", manager: "System", expectedOpens: 0, expectedProbes: 0 },
      {
        override: "false",
        platform: "darwin",
        manager: "System",
        expectedOpens: 1,
        expectedProbes: 0,
      },
      { override: "0", platform: "darwin", manager: "System", expectedOpens: 1, expectedProbes: 0 },
      { override: "", platform: "darwin", manager: "System", expectedOpens: 1, expectedProbes: 0 },
      {
        override: "maybe",
        platform: "darwin",
        manager: "Aqua",
        expectedOpens: 1,
        expectedProbes: 0,
      },
      // non-darwin → always headless, never probes, never opens, whatever the override
      {
        override: undefined,
        platform: "linux",
        manager: "Aqua",
        expectedOpens: 0,
        expectedProbes: 0,
      },
      { override: "true", platform: "linux", manager: "Aqua", expectedOpens: 0, expectedProbes: 0 },
      {
        override: "false",
        platform: "linux",
        manager: "Aqua",
        expectedOpens: 0,
        expectedProbes: 0,
      },
      {
        override: "false",
        platform: "win32",
        manager: "Aqua",
        expectedOpens: 0,
        expectedProbes: 0,
      },
      { override: "", platform: "linux", manager: "Aqua", expectedOpens: 0, expectedProbes: 0 },
    ];

    for (const row of headlessRows) {
      const label = `override=${JSON.stringify(row.override)} platform=${row.platform} manager=${row.manager instanceof Error ? "probe-error" : row.manager}`;
      test(`opens×${row.expectedOpens} probes×${row.expectedProbes} for ${label}`, async function () {
        if (row.override === undefined) {
          delete process.env[HEADLESS_ENV];
        } else {
          process.env[HEADLESS_ENV] = row.override;
        }
        try {
          simctl = new Simctl(null, recordingExec(row.manager), new FakeTimer(), row.platform);
          await simctl.openSimulatorApp();
          expect(openCalls()).toHaveLength(row.expectedOpens);
          expect(launchctlCalls()).toHaveLength(row.expectedProbes);
        } finally {
          restoreEnv();
        }
      });
    }

    test("caches the headless detection so launchctl is probed at most once", async function () {
      simctl = new Simctl(null, recordingExec("Aqua"), new FakeTimer(), "darwin");
      await simctl.openSimulatorApp();
      await simctl.openSimulatorApp();
      await simctl.openSimulatorApp();
      expect(launchctlCalls()).toHaveLength(1);
      expect(openCalls()).toHaveLength(3);
    });
  });
});
