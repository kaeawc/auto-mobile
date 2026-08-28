import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import {
  AdbClient,
  AdbCommandTimeoutError,
  AdbUnavailableError,
  resetAdbClientCaches,
} from "../../../src/utils/android-cmdline-tools/AdbClient";
import type { ExecResult } from "../../../src/models";
import { isAdbMissingDeviceError } from "../../../src/utils/android-cmdline-tools/AdbDeviceHealth";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeDiscoveryObservationSequence } from "../../fakes/FakeDiscoveryObservationSequence";

function createExecResult(stdout: string, stderr: string = ""): ExecResult {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (searchString: string) => stdout.includes(searchString),
  };
}

describe("AdbClient.getBootedAndroidDevices", () => {
  beforeEach(() => {
    resetAdbClientCaches();
  });

  test("exposes offline and unauthorized rows through the raw state probe", async () => {
    const adb = new AdbClient(null, async (command: string): Promise<ExecResult> =>
      command.includes("adb devices")
        ? createExecResult(
            [
              "List of devices attached",
              "emulator-5554\toffline",
              "emulator-5556\tunauthorized",
              "emulator-5558\tdevice",
              "",
            ].join("\n"),
          )
        : createExecResult(""),
    );

    await expect(adb.getDeviceStates()).resolves.toEqual([
      { deviceId: "emulator-5554", state: "offline" },
      { deviceId: "emulator-5556", state: "unauthorized" },
      { deviceId: "emulator-5558", state: "device" },
    ]);
  });

  afterEach(() => {
    resetAdbClientCaches();
  });

  test("only reports adb rows in device state as booted", async () => {
    const execAsync = async (command: string): Promise<ExecResult> => {
      if (command.includes("adb devices")) {
        return createExecResult(
          [
            "List of devices attached",
            "emulator-5554\tdevice product:sdk_gphone64_arm64 transport_id:42",
            "emulator-5556\tbooting",
            "emulator-5558\toffline",
            "emulator-5560\tunauthorized",
            "",
          ].join("\n"),
        );
      }
      return createExecResult("");
    };
    const timer = new FakeTimer();
    timer.advanceTime(42);
    const observations = new FakeDiscoveryObservationSequence();
    const adb = new AdbClient(null, execAsync, null, undefined, timer, undefined, observations);

    const devices = await adb.getBootedAndroidDevices();

    expect(devices).toEqual([
      {
        name: "emulator-5554",
        platform: "android",
        deviceId: "emulator-5554",
        observedAt: 1,
        transportId: "42",
      },
    ]);
  });

  test("keeps discovery ordering monotonic when the wall clock rolls back", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(100);
    const observations = new FakeDiscoveryObservationSequence();
    const adb = new AdbClient(
      null,
      async () =>
        createExecResult(["List of devices attached", "emulator-5554\tdevice", ""].join("\n")),
      null,
      undefined,
      timer,
      undefined,
      observations,
    );

    const initial = await adb.getBootedAndroidDevices();
    timer.setCurrentTime(1);
    const afterRollback = await adb.getBootedAndroidDevices({ bypassCache: true });

    expect(initial[0]?.observedAt).toBe(1);
    expect(afterRollback[0]?.observedAt).toBe(2);
  });

  test("bypasses the device-list cache when checking a connection incarnation", async () => {
    let calls = 0;
    const adb = new AdbClient(null, async (command: string): Promise<ExecResult> => {
      if (!command.includes("adb devices")) {
        return createExecResult("");
      }
      calls++;
      return createExecResult(
        ["List of devices attached", `emulator-5554\tdevice transport_id:${calls}`, ""].join("\n"),
      );
    });

    expect(await adb.getBootedAndroidDevices()).toMatchObject([{ transportId: "1" }]);
    expect(await adb.getBootedAndroidDevices({ bypassCache: true })).toMatchObject([
      { transportId: "2" },
    ]);
    expect(calls).toBe(2);
  });

  test("can rethrow when adb is unavailable for strict discovery", async () => {
    const adb = new AdbClient(null, async () => {
      throw new Error("spawn adb ENOENT");
    });

    await expect(adb.getBootedAndroidDevices({ throwOnMissingAdb: true })).rejects.toBeInstanceOf(
      AdbUnavailableError,
    );
  });

  test("serves the device-list cache for strict discovery unless the caller bypasses it", async () => {
    const availableAdb = new AdbClient(null, async () =>
      createExecResult(["List of devices attached", "emulator-5554\tdevice", ""].join("\n")),
    );
    await expect(availableAdb.getBootedAndroidDevices()).resolves.toMatchObject([
      { deviceId: "emulator-5554" },
    ]);

    // Strict discovery only changes how a missing adb is reported; hot read
    // paths keep the shared cache. Boot/terminate flows opt into fresh data
    // with bypassCache.
    const unavailableAdb = new AdbClient(null, async () => {
      throw new Error("spawn adb ENOENT");
    });
    await expect(
      unavailableAdb.getBootedAndroidDevices({ throwOnMissingAdb: true }),
    ).resolves.toMatchObject([{ deviceId: "emulator-5554" }]);
    await expect(
      unavailableAdb.getBootedAndroidDevices({ throwOnMissingAdb: true, bypassCache: true }),
    ).rejects.toBeInstanceOf(AdbUnavailableError);
  });

  test("does not retry commands when adb reports the target serial is gone", async () => {
    let calls = 0;
    const execAsync = async (): Promise<ExecResult> => {
      calls++;
      throw new Error(
        "Command failed: adb -s emulator-5554 shell true\nstderr: adb: device 'emulator-5554' not found",
      );
    };
    const adb = new AdbClient(
      { name: "Pixel 8", platform: "android", deviceId: "emulator-5554" },
      execAsync,
    );

    await expect(adb.executeCommand("shell true")).rejects.toThrow(
      /device 'emulator-5554' not found/,
    );
    expect(calls).toBe(1);
  });

  test("does not treat generic no-device output as serial-specific disappearance", () => {
    expect(
      isAdbMissingDeviceError(new Error("error: no devices/emulators found"), "emulator-5554"),
    ).toBe(false);
    expect(isAdbMissingDeviceError(new Error("error: device not found"), "emulator-5554")).toBe(
      false,
    );
    expect(
      isAdbMissingDeviceError(new Error("adb: device 'emulator-5554' not found"), "emulator-5554"),
    ).toBe(true);
  });

  test("keeps default aborts on the Operation cancelled contract", async () => {
    const adb = new AdbClient(
      { name: "Pixel 8", platform: "android", deviceId: "emulator-5554" },
      async () => createExecResult(""),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      adb.executeCommand("shell true", undefined, undefined, true, controller.signal),
    ).rejects.toThrow("Operation cancelled");
  });

  test("executes argv with one device selector and the resolved executable", async () => {
    let received: { file: string; args: string[] } | undefined;
    const adb = new AdbClient(
      { name: "Pixel 8", platform: "android", deviceId: "emulator-5554" },
      async (file: string, args: string[], _maxBuffer?: number): Promise<ExecResult> => {
        received = { file, args };
        return createExecResult("ok");
      },
    );

    await adb.execute(["shell", "getprop", "ro.product.model"], { noRetry: true });

    expect(received?.file).toEndWith("adb");
    expect(received?.args).toEqual(["-s", "emulator-5554", "shell", "getprop", "ro.product.model"]);
  });

  test("spawns argv without retry and terminates only its child on abort", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killCalls: [] as string[],
      kill(signal?: string) {
        this.killCalls.push(signal ?? "SIGTERM");
        return true;
      },
    });
    let received: { file: string; args: string[] } | undefined;
    const adb = new AdbClient(
      { name: "Pixel 8", platform: "android", deviceId: "emulator-5554" },
      async (): Promise<ExecResult> => createExecResult(""),
      ((file: string, args: string[]) => {
        received = { file, args };
        return child;
      }) as never,
    );
    const controller = new AbortController();

    const pending = adb.spawn(["exec-out", "screenrecord", "--output-format=h264", "-"], {
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    child.emit("spawn");
    const process = await pending;
    controller.abort();
    child.emit("exit", null, "SIGTERM");

    expect(process.stdout).toBe(child.stdout);
    expect(received?.file).toEndWith("adb");
    expect(received?.args).toEqual([
      "-s",
      "emulator-5554",
      "exec-out",
      "screenrecord",
      "--output-format=h264",
      "-",
    ]);
    expect(child.killCalls).toEqual(["SIGTERM"]);
  });

  test("does not spawn when cancellation arrives during executable resolution", async () => {
    let resolveBase: ((value: { adbPath: string; baseArgs: string[] }) => void) | undefined;
    let spawnCalls = 0;
    const adb = new AdbClient(null, async (): Promise<ExecResult> => createExecResult(""), (() => {
      spawnCalls++;
      throw new Error("must not spawn");
    }) as never);
    (
      adb as unknown as {
        getBaseCommandParts: () => Promise<{ adbPath: string; baseArgs: string[] }>;
      }
    ).getBaseCommandParts = () =>
      new Promise((resolve) => {
        resolveBase = resolve;
      });
    const controller = new AbortController();
    const pending = adb.spawn(["get-state"], { signal: controller.signal });
    controller.abort();
    resolveBase!({ adbPath: "adb", baseArgs: [] });

    await expect(pending).rejects.toThrow("Operation cancelled");
    expect(spawnCalls).toBe(0);
  });

  test("does not spawn when executable resolution exhausts the timeout budget", async () => {
    const timer = new FakeTimer();
    let spawnCalls = 0;
    const adb = new AdbClient(
      null,
      async (): Promise<ExecResult> => createExecResult(""),
      (() => {
        spawnCalls++;
        throw new Error("must not spawn");
      }) as never,
      undefined,
      timer,
    );
    (
      adb as unknown as {
        getBaseCommandParts: () => Promise<{ adbPath: string; baseArgs: string[] }>;
      }
    ).getBaseCommandParts = async () => {
      timer.advanceTime(100);
      return { adbPath: "adb", baseArgs: [] };
    };

    await expect(adb.spawn(["get-state"], { timeoutMs: 100 })).rejects.toBeInstanceOf(
      AdbCommandTimeoutError,
    );
    expect(spawnCalls).toBe(0);
  });
});
