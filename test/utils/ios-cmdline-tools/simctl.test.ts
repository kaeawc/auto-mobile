import { expect, describe, test, beforeEach } from "bun:test";
import { Simctl } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { BootedDevice, ExecResult } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../../src/utils/deviceTimeouts";

function resetSimctlCaches(): void {
  const simctlClass = Simctl as unknown as {
    deviceListCache: { devices: unknown[]; timestamp: number } | null;
    localSimctlAvailability: Promise<void> | null;
  };
  simctlClass.deviceListCache = null;
  simctlClass.localSimctlAvailability = null;
}

function forceStaticAvailabilityPath(instance: Simctl): void {
  (instance as unknown as { usesInjectedExecAsync: boolean }).usesInjectedExecAsync = false;
}

function simulatorListPayload(devices: unknown[]): string {
  return JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-4": devices
    },
    runtimes: [],
    devicetypes: [],
    pairs: []
  });
}

describe("Simctl", function() {
  let simctl: Simctl;
  let mockDevice: BootedDevice;
  let mockExecAsync: (file: string, args: string[], maxBuffer?: number, signal?: AbortSignal) => Promise<ExecResult>;

  beforeEach(function() {
    resetSimctlCaches();

    mockDevice = {
      deviceId: "test-ios-device-id",
      name: "Test iOS Device",
      platform: "ios",
      source: "local"
    };

    mockExecAsync = async (): Promise<ExecResult> => {
      return {
        stdout: "",
        stderr: "",
        toString: () => "",
        trim: () => "",
        includes: () => false
      };
    };

    simctl = new Simctl(mockDevice, mockExecAsync);
  });

  describe("isAvailable", function() {
    test("should return true when simctl is available", async function() {
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return {
            stdout: "simctl version 1.0.0",
            stderr: "",
            toString: () => "simctl version 1.0.0",
            trim: () => "simctl version 1.0.0",
            includes: () => false
          };
        }
        return { stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false };
      };

      simctl = new Simctl(null, mockExecAsync);

      const available = await simctl.isAvailable();
      expect(available).toBe(true);
    });

    test("should return false when simctl is not available", async function() {
      mockExecAsync = async (): Promise<ExecResult> => {
        throw new Error("Command not found: xcrun");
      };

      simctl = new Simctl(null, mockExecAsync);

      const available = await simctl.isAvailable();
      expect(available).toBe(false);
    });
  });

  describe("executeCommand", function() {
    test("should execute simctl commands with xcrun prefix", async function() {
      let executedFile = "";
      let executedArgs: string[] = [];
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        executedFile = file;
        executedArgs = args;
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return {
            stdout: "simctl version 1.0.0",
            stderr: "",
            toString: () => "simctl version 1.0.0",
            trim: () => "simctl version 1.0.0",
            includes: () => false
          };
        }
        return {
          stdout: "command executed",
          stderr: "",
          toString: () => "command executed",
          trim: () => "command executed",
          includes: () => false
        };
      };

      simctl = new Simctl(mockDevice, mockExecAsync);
      await simctl.executeCommand("list devices");

      expect(executedFile).toBe("xcrun");
      expect(executedArgs).toEqual(["simctl", "list", "devices"]);
    });

    test("should execute pre-split simctl arguments without dropping empty strings or backslashes", async function() {
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

  describe("startSimulator", function() {
    test("uses bootstatus -b instead of raw boot so already-booted simulators are accepted", async function() {
      const commands: string[][] = [];
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        commands.push([file, ...args]);
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1.0.0", "");
        }
        if (file === "xcrun" && args.join(" ") === "simctl boot test-ios-device-id") {
          throw new Error("raw boot should not be called");
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
      expect(commands).not.toContainEqual([
        "xcrun",
        "simctl",
        "boot",
        "test-ios-device-id",
      ]);
    });

    test("applies timeout to the bootstatus wait", async function() {
      const timer = new FakeTimer();
      let resolveCommand: ((result: ExecResult) => void) | undefined;
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1.0.0", "");
        }
        return new Promise<ExecResult>(resolve => {
          resolveCommand = resolve;
        });
      };

      simctl = new Simctl(mockDevice, mockExecAsync, timer);

      const bootPromise = simctl.startSimulator("test-ios-device-id", 1234);
      while (!resolveCommand) {
        await Promise.resolve();
      }
      timer.advanceTime(1234);

      await expect(bootPromise).rejects.toThrow(
        "Command timed out after 1234ms: xcrun simctl bootstatus test-ios-device-id -b",
      );
      resolveCommand?.(createExecResult("late bootstatus", ""));
    });

    test("applies the default timeout to the bootstatus wait", async function() {
      const timer = new FakeTimer();
      let resolveCommand: ((result: ExecResult) => void) | undefined;
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1.0.0", "");
        }
        return new Promise<ExecResult>(resolve => {
          resolveCommand = resolve;
        });
      };

      simctl = new Simctl(mockDevice, mockExecAsync, timer);

      const bootPromise = simctl.startSimulator("test-ios-device-id");
      while (!resolveCommand) {
        await Promise.resolve();
      }
      timer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS);

      await expect(bootPromise).rejects.toThrow(
        `Command timed out after ${DEFAULT_DEVICE_READY_TIMEOUT_MS}ms: xcrun simctl bootstatus test-ios-device-id -b`,
      );
      resolveCommand?.(createExecResult("late bootstatus", ""));
    });

    test("aborts the underlying child process when the bootstatus wait times out", async function() {
      const timer = new FakeTimer();
      let capturedSignal: AbortSignal | undefined;
      mockExecAsync = async (file: string, args: string[], _maxBuffer?: number, signal?: AbortSignal): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1.0.0", "");
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
      while (!capturedSignal) {
        await Promise.resolve();
      }
      expect(capturedSignal.aborted).toBe(false);

      timer.advanceTime(1234);

      await expect(bootPromise).rejects.toThrow(
        "Command timed out after 1234ms: xcrun simctl bootstatus test-ios-device-id -b",
      );
      // The timeout must abort the child rather than leave it running orphaned.
      expect(capturedSignal.aborted).toBe(true);
    });
  });

  describe("startSimulator returned handle", function() {
    test("does not fabricate a pid (no real OS process backs a synchronous bootstatus)", async function() {
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1.0.0", "");
        }
        return createExecResult("", "");
      };
      simctl = new Simctl(mockDevice, mockExecAsync);

      const handle = await simctl.startSimulator("iphone-udid");

      // AC3: honest handle — no fabricated timestamp pid.
      expect(handle.pid).toBeUndefined();
    });

    test("kill() shuts the simulator back down instead of being a no-op", async function() {
      const commands: string[][] = [];
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        commands.push([file, ...args]);
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return createExecResult("simctl version 1.0.0", "");
        }
        return createExecResult("", "");
      };
      simctl = new Simctl(mockDevice, mockExecAsync);

      const handle = await simctl.startSimulator("iphone-udid");

      // AC1: kill() reports success and issues `simctl shutdown <udid>` rather
      // than the previous no-op `() => false`.
      expect(handle.kill()).toBe(true);
      for (let i = 0; i < 25 && !commands.some(c => c.includes("shutdown")); i++) {
        await Promise.resolve();
      }
      expect(commands).toContainEqual(["xcrun", "simctl", "shutdown", "iphone-udid"]);
    });
  });

  describe("waitForSimulatorReady", function() {
    const readyPayload = simulatorListPayload([
      {
        udid: "iphone-17-pro-udid",
        name: "iPhone 17 Pro",
        state: "Booted",
        isAvailable: true,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
        os_version: "26.4"
      }
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

    test("runs bootstatus -b on the already-running path (no assumeBooted)", async function() {
      const commands: string[][] = [];
      simctl = new Simctl(mockDevice, recordingReadyExec(commands));

      const device = await simctl.waitForSimulatorReady("iphone-17-pro-udid");

      expect(device.deviceId).toBe("iphone-17-pro-udid");
      expect(commands).toContainEqual([
        "xcrun", "simctl", "bootstatus", "iphone-17-pro-udid", "-b",
      ]);
    });

    test("skips the redundant bootstatus -b when assumeBooted is set (cold-boot path)", async function() {
      const commands: string[][] = [];
      simctl = new Simctl(mockDevice, recordingReadyExec(commands));

      const device = await simctl.waitForSimulatorReady("iphone-17-pro-udid", 1234, { assumeBooted: true });

      expect(device.deviceId).toBe("iphone-17-pro-udid");
      // The cold-boot path already waited via startSimulator; no second boot wait.
      expect(commands.some(c => c.includes("bootstatus"))).toBe(false);
    });
  });

  describe("listSimulatorImages", function() {
    test("should retry local simctl availability after a transient failed probe", async function() {
      let versionProbeCalls = 0;
      const payload = simulatorListPayload([
        {
          udid: "iphone-17-pro-udid",
          name: "iPhone 17 Pro",
          state: "Booted",
          isAvailable: true,
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
          os_version: "26.4"
        }
      ]);

      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          versionProbeCalls++;
          if (versionProbeCalls === 1) {
            throw new Error("transient xcrun failure");
          }
          return createExecResult("simctl version 1051.50", "");
        }
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          return createExecResult(payload, "");
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync, undefined, "darwin");
      forceStaticAvailabilityPath(simctl);

      await expect(simctl.listSimulatorImages()).rejects.toThrow(/transient xcrun failure/);
      const devices = await simctl.listSimulatorImages();

      expect(versionProbeCalls).toBe(2);
      expect(devices.map(device => device.name)).toEqual(["iPhone 17 Pro"]);
    });

    test("should not cache an empty simulator discovery result", async function() {
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
          os_version: "26.4"
        }
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
      expect(devices.map(device => device.name)).toEqual(["iPhone 17 Pro"]);
    });

    test("should surface simctl discovery failures instead of returning an empty list", async function() {
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
        /Failed to list iOS simulator devices.*simctl list devices exploded/
      );
    });

    test("should include unavailable and transitional simulators", async function() {
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
              architecture: "arm64"
            },
            {
              udid: "shutdown-udid",
              name: "iPhone 15",
              state: "Shutdown",
              isAvailable: true,
              deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
              os_version: "17.4"
            },
            {
              udid: "creating-udid",
              name: "iPhone 14",
              state: "Creating",
              isAvailable: true,
              deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-14",
              os_version: "17.4"
            },
            {
              udid: "unavailable-udid",
              name: "iPhone 13",
              state: "Unavailable",
              isAvailable: false,
              availabilityError: "runtime missing",
              deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-13"
            }
          ]
        },
        runtimes: [],
        devicetypes: [],
        pairs: []
      };

      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl --version") {
          return {
            stdout: "simctl version 1.0.0",
            stderr: "",
            toString: () => "simctl version 1.0.0",
            trim: () => "simctl version 1.0.0",
            includes: () => false
          };
        }
        if (file === "xcrun" && args.join(" ") === "simctl list devices --json") {
          const payload = JSON.stringify(simulatorPayload);
          return {
            stdout: payload,
            stderr: "",
            toString: () => payload,
            trim: () => payload.trim(),
            includes: (search: string) => payload.includes(search)
          };
        }
        return { stdout: "", stderr: "", toString: () => "", trim: () => "", includes: () => false };
      };

      simctl = new Simctl(null, mockExecAsync);

      const devices = await simctl.listSimulatorImages();

      expect(devices).toHaveLength(4);
      const unavailable = devices.find(device => device.deviceId === "unavailable-udid");
      expect(unavailable?.state).toBe("Unavailable");
      expect(unavailable?.isAvailable).toBe(false);
      expect(unavailable?.availabilityError).toBe("runtime missing");
      expect(unavailable?.runtime).toBe("com.apple.CoreSimulator.SimRuntime.iOS-17-4");
      expect(unavailable?.iosVersion).toBe("17.4");
    });
  });

  describe("getRuntimes uses dedicated simctl command", function() {
    test("should return runtimes from simctl list runtimes --json", async function() {
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl list runtimes --json") {
          return createExecResult(JSON.stringify({
            runtimes: [
              {
                bundlePath: "/Library/Developer/CoreSimulator/Volumes/iOS_26.2/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 26.2.simruntime",
                identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-2",
                isAvailable: true,
                name: "iOS 26.2",
                version: "26.2"
              },
              {
                bundlePath: "/Library/Developer/CoreSimulator/Volumes/iOS_18.6/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 18.6.simruntime",
                identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
                isAvailable: false,
                name: "iOS 18.6",
                version: "18.6"
              }
            ]
          }), "");
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync);
      const runtimes = await simctl.getRuntimes();
      expect(runtimes).toHaveLength(1);
      expect(runtimes[0].name).toBe("iOS 26.2");
      expect(runtimes[0].isAvailable).toBe(true);
    });

    test("should throw when runtimes command fails", async function() {
      mockExecAsync = async (): Promise<ExecResult> => {
        throw new Error("simctl failed");
      };

      simctl = new Simctl(null, mockExecAsync);
      await expect(simctl.getRuntimes()).rejects.toThrow();
    });
  });

  describe("getDeviceTypes uses dedicated simctl command", function() {
    test("should return device types from simctl list devicetypes --json", async function() {
      mockExecAsync = async (file: string, args: string[]): Promise<ExecResult> => {
        if (file === "xcrun" && args.join(" ") === "simctl list devicetypes --json") {
          return createExecResult(JSON.stringify({
            devicetypes: [
              {
                name: "iPhone 17 Pro",
                identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
                bundlePath: "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone 17 Pro.simdevicetype"
              }
            ]
          }), "");
        }
        return createExecResult("", "");
      };

      simctl = new Simctl(null, mockExecAsync);
      const types = await simctl.getDeviceTypes();
      expect(types).toHaveLength(1);
      expect(types[0].name).toBe("iPhone 17 Pro");
    });

    test("should throw when devicetypes command fails", async function() {
      mockExecAsync = async (): Promise<ExecResult> => {
        throw new Error("simctl failed");
      };

      simctl = new Simctl(null, mockExecAsync);
      await expect(simctl.getDeviceTypes()).rejects.toThrow();
    });
  });

  describe("openSimulatorApp headless detection", function() {
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
      return calls.filter(c => c.file === "open" && c.args[0] === "-a" && c.args[1] === "Simulator");
    }

    function launchctlCalls(): Array<{ file: string; args: string[] }> {
      return calls.filter(c => c.file === "launchctl" && c.args[0] === "managername");
    }

    beforeEach(function() {
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

    test("skips open -a Simulator when AUTOMOBILE_IOS_HEADLESS=true (no launchctl probe)", async function() {
      process.env[HEADLESS_ENV] = "true";
      try {
        simctl = new Simctl(null, recordingExec("Aqua"), new FakeTimer(), "darwin");
        await simctl.openSimulatorApp();
        expect(openCalls()).toHaveLength(0);
        expect(launchctlCalls()).toHaveLength(0);
      } finally {
        restoreEnv();
      }
    });

    test("forces open -a Simulator when AUTOMOBILE_IOS_HEADLESS=false even if session is non-Aqua", async function() {
      process.env[HEADLESS_ENV] = "false";
      try {
        simctl = new Simctl(null, recordingExec("System"), new FakeTimer(), "darwin");
        await simctl.openSimulatorApp();
        expect(openCalls()).toHaveLength(1);
        expect(launchctlCalls()).toHaveLength(0);
      } finally {
        restoreEnv();
      }
    });

    test("calls open -a Simulator when launchctl reports an Aqua GUI session", async function() {
      simctl = new Simctl(null, recordingExec("Aqua"), new FakeTimer(), "darwin");
      await simctl.openSimulatorApp();
      expect(launchctlCalls()).toHaveLength(1);
      expect(openCalls()).toHaveLength(1);
    });

    test("skips open -a Simulator when launchctl reports a non-Aqua (headless) session", async function() {
      simctl = new Simctl(null, recordingExec("System"), new FakeTimer(), "darwin");
      await simctl.openSimulatorApp();
      expect(launchctlCalls()).toHaveLength(1);
      expect(openCalls()).toHaveLength(0);
    });

    test("skips open -a Simulator on non-darwin platforms without any exec", async function() {
      simctl = new Simctl(null, recordingExec("Aqua"), new FakeTimer(), "linux");
      await simctl.openSimulatorApp();
      expect(calls).toHaveLength(0);
    });

    test("attempts open -a Simulator when launchctl probe fails (safe fallback)", async function() {
      simctl = new Simctl(null, recordingExec(new Error("launchctl unavailable")), new FakeTimer(), "darwin");
      await simctl.openSimulatorApp();
      expect(launchctlCalls()).toHaveLength(1);
      expect(openCalls()).toHaveLength(1);
    });

    test("caches the headless detection so launchctl is probed at most once", async function() {
      simctl = new Simctl(null, recordingExec("Aqua"), new FakeTimer(), "darwin");
      await simctl.openSimulatorApp();
      await simctl.openSimulatorApp();
      await simctl.openSimulatorApp();
      expect(launchctlCalls()).toHaveLength(1);
      expect(openCalls()).toHaveLength(3);
    });
  });
});
