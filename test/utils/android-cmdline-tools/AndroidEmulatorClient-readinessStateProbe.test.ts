import { describe, expect, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";

const result = (stdout = "", stderr = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value: string) => stdout.includes(value),
});

const expectRejection = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected the operation to reject");
};

describe("Android emulator readiness adb state probe", () => {
  test("reports a target that remains offline instead of waiting for the generic timeout", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.getDeviceStates = async () => {
      if (timer.now() < 16_000) {
        return [{ deviceId: "emulator-5554", state: "offline" }];
      }

      adb.setDevices([{ name: "Pixel_9_Pro", platform: "android", deviceId: "emulator-5554" }]);
      adb.setCommandResponse("get-state", result("device"));
      adb.setCommandResponse("shell pm list packages", result("package:com.example\n"));
      adb.setCommandResponse("shell getprop sys.boot_completed", result("1"));
      adb.setCommandResponse("shell getprop init.svc.bootanim", result("stopped"));
      return [{ deviceId: "emulator-5554", state: "device" }];
    };
    const client = new AndroidEmulatorClient({
      execAsync: async () => result(),
      timer,
      adbFactory: {
        create: () => adb,
      } as AdbClientFactory,
    });
    const previousPollingInterval = process.env.EMULATOR_POLLING_INTERVAL_MS;
    process.env.EMULATOR_POLLING_INTERVAL_MS = "500";

    try {
      const readiness = client.waitForEmulatorReady("Pixel_9_Pro", 20_000, null, "emulator-5554");
      const booted = await timer.resolvePromise(readiness, 500);
      expect(booted.deviceId).toBe("emulator-5554");
    } finally {
      if (previousPollingInterval === undefined) {
        delete process.env.EMULATOR_POLLING_INTERVAL_MS;
      } else {
        process.env.EMULATOR_POLLING_INTERVAL_MS = previousPollingInterval;
      }
    }
  });

  test("continues readiness checks when the auxiliary state probe fails", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setDevices([{ name: "Pixel_9_Pro", platform: "android", deviceId: "emulator-5554" }]);
    adb.setCommandResponse("get-state", result("device"));
    adb.setCommandResponse("shell pm list packages", result("package:com.example\n"));
    adb.setCommandResponse("shell getprop sys.boot_completed", result("1"));
    adb.setCommandResponse("shell getprop init.svc.bootanim", result("stopped"));
    adb.getDeviceStates = async () => {
      throw new Error("state probe unavailable");
    };
    const client = new AndroidEmulatorClient({
      execAsync: async () => result(),
      timer,
      adbFactory: {
        create: () => adb,
      } as AdbClientFactory,
    });

    const booted = await client.waitForEmulatorReady("Pixel_9_Pro", 20_000, null, "emulator-5554");
    expect(booted.deviceId).toBe("emulator-5554");
  });

  test("bounds the auxiliary state probe by the readiness deadline", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    const observedTimeouts: Array<number | undefined> = [];
    adb.getDeviceStates = async (options) => {
      observedTimeouts.push(options?.timeoutMs);
      return [];
    };
    const client = new AndroidEmulatorClient({
      execAsync: async () => result(),
      timer,
      adbFactory: {
        create: () => adb,
      } as AdbClientFactory,
    });

    await expectRejection(client.waitForEmulatorReady("Pixel_9_Pro", 100, null, "emulator-5554"));
    expect(observedTimeouts[0]).toBe(100);
  });
});
