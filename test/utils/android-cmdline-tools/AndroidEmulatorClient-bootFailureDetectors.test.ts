import { describe, expect, test } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AvdConfigReader } from "../../../src/utils/android-cmdline-tools/AvdConfigReader";

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

describe("Android emulator boot failure diagnostics", () => {
  test("detects mprotect and HVF sandbox signatures", () => {
    const client = new AndroidEmulatorClient(async () => result());

    expect(client.detectSandboxMprotect("qemu_mprotect__osdep: mprotect failed: Permission denied").isSandboxError).toBe(true);
    expect(client.detectSandboxMprotect("hvf is not enabled on this aarch64 host").isSandboxError).toBe(true);
    expect(client.detectSandboxMprotect("HVF error: HV_UNSUPPORTED").isSandboxError).toBe(true);
    expect(client.detectSandboxMprotect("HVF error: HV_ERROR").isSandboxError).toBe(true);
    expect(client.detectSandboxMprotect("failed to initialize HVF: Invalid argument").isSandboxError).toBe(true);
    expect(client.detectSandboxMprotect("Detected GPU type: host").isSandboxError).toBe(false);
  });

  test("fails before spawning an AVD whose configured RAM is below the floor", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const reader: AvdConfigReader = { readConfig: async () => ({ apiLevel: 36, tag: "google_apis_playstore", ramSizeMb: 1024 }) };
    const client = new AndroidEmulatorClient(
      async (_file, args) => args.includes("-list-avds") ? result("Pixel_9_Pro\n") : result(),
      (() => { throw new Error("spawn should not be reached"); }) as any,
      timer,
      { create: () => new FakeAdbExecutor() } as AdbClientFactory,
      reader,
    );
    (client as unknown as { isAvdRunning: () => Promise<boolean> }).isAvdRunning = async () => false;
    (client as unknown as { isAvdStarting: () => Promise<boolean> }).isAvdStarting = async () => false;
    (client as unknown as { checkArchitectureCompatibility: () => Promise<unknown> }).checkArchitectureCompatibility = async () => ({ compatible: true });

    const error = await expectRejection(client.startEmulator("Pixel_9_Pro"));
    expect(error.message).toContain("hw.ramSize");
    expect(error.message).toContain("1024 MB");
    expect(error.message).toContain("2048 MB");
  });

  test("reports a target that remains offline instead of waiting for the generic timeout", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setDeviceStates([{ deviceId: "emulator-5554", state: "offline" }]);
    const client = new AndroidEmulatorClient(
      async () => result(),
      null,
      timer,
      { create: () => adb } as AdbClientFactory,
    );
    const previousPollingInterval = process.env.EMULATOR_POLLING_INTERVAL_MS;
    process.env.EMULATOR_POLLING_INTERVAL_MS = "500";

    try {
      const error = await expectRejection(client.waitForEmulatorReady("Pixel_9_Pro", 20_000, null, "emulator-5554"));
      expect(error.message).toContain("offline");
      expect(error.message).toContain("15 seconds");
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
    adb.getDeviceStates = async () => { throw new Error("state probe unavailable"); };
    const client = new AndroidEmulatorClient(
      async () => result(),
      null,
      timer,
      { create: () => adb } as AdbClientFactory,
    );

    const booted = await client.waitForEmulatorReady("Pixel_9_Pro", 20_000, null, "emulator-5554");
    expect(booted.deviceId).toBe("emulator-5554");
  });

  test("clears a stale offline diagnosis when the target recovers", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    const client = new AndroidEmulatorClient(async () => result(), null, timer, { create: () => adb } as AdbClientFactory);
    const detectOfflineFailure = (client as unknown as {
      detectOfflineFailure: (
        avdName: string,
        deviceId: string | undefined,
        tracker: { deviceId: string | null; since: number | null },
      ) => Promise<Error | null>;
    }).detectOfflineFailure.bind(client);
    const tracker = { deviceId: null as string | null, since: null as number | null };

    adb.setDeviceStates([{ deviceId: "emulator-5554", state: "offline" }]);
    await detectOfflineFailure("Pixel_9_Pro", "emulator-5554", tracker);
    timer.advanceTime(15_000);
    const offlineFailure = await detectOfflineFailure("Pixel_9_Pro", "emulator-5554", tracker);
    expect(offlineFailure?.message).toContain("offline");

    adb.setDeviceStates([{ deviceId: "emulator-5554", state: "device" }]);
    const recoveredFailure = await detectOfflineFailure("Pixel_9_Pro", "emulator-5554", tracker);
    expect(recoveredFailure).toBeNull();
    expect(tracker.since).toBeNull();
  });

  test("bounds the auxiliary state probe by the readiness deadline", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    const observedTimeouts: Array<number | undefined> = [];
    adb.getDeviceStates = async options => {
      observedTimeouts.push(options?.timeoutMs);
      return [];
    };
    const client = new AndroidEmulatorClient(async () => result(), null, timer, { create: () => adb } as AdbClientFactory);

    await expectRejection(client.waitForEmulatorReady("Pixel_9_Pro", 100, null, "emulator-5554"));
    expect(observedTimeouts[0]).toBe(100);
  });

});
