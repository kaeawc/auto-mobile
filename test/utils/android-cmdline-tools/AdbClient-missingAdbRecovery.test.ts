import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AdbClient,
  resetAdbClientCaches,
} from "../../../src/utils/android-cmdline-tools/AdbClient";
import { clearDetectionCache } from "../../../src/utils/android-cmdline-tools/detection";
import type { ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

type AdbClientInternals = {
  isTestMode: boolean;
  execWithSignal: (
    file: string,
    args: string[],
    maxBuffer?: number,
    timeoutMs?: number,
    signal?: AbortSignal,
  ) => Promise<ExecResult>;
};

function result(stdout = ""): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (value: string) => stdout.includes(value),
  };
}

function missingAdb(): Error & { code: string } {
  return Object.assign(new Error("spawn adb ENOENT"), { code: "ENOENT" });
}

describe.serial("AdbClient missing ADB recovery", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const androidEnvironmentNames = ["ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_SDK_HOME"];
  const originalAndroidEnvironment = new Map(
    androidEnvironmentNames.map((name) => [name, process.env[name]]),
  );

  beforeEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    resetAdbClientCaches();
    clearDetectionCache();
    for (const name of androidEnvironmentNames) {
      delete process.env[name];
    }
  });

  afterEach(() => {
    resetAdbClientCaches();
    clearDetectionCache();
    for (const name of androidEnvironmentNames) {
      const value = originalAndroidEnvironment.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  test("does not cache a failed detection's bare adb fallback", async () => {
    const client = new AdbClient(null, null, null, undefined, new FakeTimer(), () => {
      throw new Error("SDK detection unavailable");
    });
    const internals = client as unknown as AdbClientInternals;
    internals.isTestMode = false;
    let whichCalls = 0;
    internals.execWithSignal = async (file, args) => {
      if (file === "which" && args[0] === "adb") {
        whichCalls++;
        return result(whichCalls === 1 ? "" : "/sdk/platform-tools/adb\n");
      }
      return result();
    };

    await expect(client.getAdbPathOnly()).resolves.toBe("adb");
    await expect(client.getAdbPathOnly()).resolves.toBe("/sdk/platform-tools/adb");

    expect(whichCalls).toBe(2);
  });

  test("resets the missing probe guard after a real path is detected and scans recover", async () => {
    const timer = new FakeTimer();
    const client = new AdbClient(null, null, null, undefined, timer, () => {
      throw new Error("SDK detection unavailable");
    });
    const internals = client as unknown as AdbClientInternals;
    internals.isTestMode = false;
    let resolvedPath = false;
    let deviceCalls = 0;
    internals.execWithSignal = async (file, args) => {
      if (file === "which" && args[0] === "adb") {
        return result(resolvedPath ? "/sdk/platform-tools/adb\n" : "");
      }
      if (args[0] === "devices") {
        deviceCalls++;
        if (!resolvedPath) {
          throw missingAdb();
        }
        return result("List of devices attached\nemulator-5554\tdevice\n");
      }
      return result();
    };

    await client.getDeviceStates();
    await client.getDeviceStates();
    await client.getDeviceStates();
    expect(deviceCalls).toBe(3);
    await client.getDeviceStates();
    expect(deviceCalls).toBe(3);

    resolvedPath = true;
    await expect(client.getAdbPathOnly()).resolves.toBe("/sdk/platform-tools/adb");
    await expect(client.getDeviceStates()).resolves.toEqual([
      { deviceId: "emulator-5554", state: "device" },
    ]);
    expect(deviceCalls).toBe(4);
    await expect(client.getBootedAndroidDevices({ bypassCache: true })).resolves.toMatchObject([
      { deviceId: "emulator-5554" },
    ]);
    expect(deviceCalls).toBe(5);
  });

  test("resets the missing probe guard after a successful adb command", async () => {
    const client = new AdbClient(null, null, null, undefined, new FakeTimer(), () => {
      throw new Error("SDK detection unavailable");
    });
    const internals = client as unknown as AdbClientInternals;
    internals.isTestMode = false;
    let deviceCalls = 0;
    internals.execWithSignal = async (file, args) => {
      if (file === "which" && args[0] === "adb") {
        return result("");
      }
      if (args[0] === "devices") {
        deviceCalls++;
        if (deviceCalls <= 3) {
          throw missingAdb();
        }
        return result("List of devices attached\nemulator-5558\tdevice\n");
      }
      return result();
    };

    await client.getDeviceStates();
    await client.getDeviceStates();
    await client.getDeviceStates();
    await client.getDeviceStates();
    expect(deviceCalls).toBe(3);

    await client.execute(["version"], { noRetry: true });
    await expect(client.getDeviceStates()).resolves.toEqual([
      { deviceId: "emulator-5558", state: "device" },
    ]);
    expect(deviceCalls).toBe(4);
  });

  test("retries a skipped scan after the recovery window expires", async () => {
    const timer = new FakeTimer();
    const client = new AdbClient(null, null, null, undefined, timer, () => {
      throw new Error("SDK detection unavailable");
    });
    const internals = client as unknown as AdbClientInternals;
    internals.isTestMode = false;
    let deviceCalls = 0;
    internals.execWithSignal = async (file, args) => {
      if (file === "which" && args[0] === "adb") {
        return result("");
      }
      if (args[0] === "devices") {
        deviceCalls++;
        if (deviceCalls <= 3) {
          throw missingAdb();
        }
        return result("List of devices attached\nemulator-5556\tdevice\n");
      }
      return result();
    };

    await client.getDeviceStates();
    await client.getDeviceStates();
    await client.getDeviceStates();
    await client.getDeviceStates();
    expect(deviceCalls).toBe(3);

    timer.advanceTime(30000);
    await expect(client.getDeviceStates()).resolves.toEqual([
      { deviceId: "emulator-5556", state: "device" },
    ]);
    expect(deviceCalls).toBe(4);
  });
});
