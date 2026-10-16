import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { ActionableError, type BootedDevice, type ExecResult } from "../../../src/models";
import type { HostChildProcess } from "../../../src/utils/HostCommandExecutor";
import {
  DefaultEmulatorReadinessPoller,
  resolveEmulatorPollingInterval,
  type EmulatorReadinessHost,
} from "../../../src/utils/android-cmdline-tools/EmulatorReadinessPoller";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const result = (stdout = ""): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value: string) => stdout.includes(value),
});

function readyAdb(overrides: Record<string, string> = {}): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  const responses: Record<string, string> = {
    "get-state": "device\n",
    "shell pm list packages": "package:android\n",
    "shell getprop sys.boot_completed": "1\n",
    "shell getprop init.svc.bootanim": "stopped\n",
    ...overrides,
  };
  for (const [command, stdout] of Object.entries(responses)) {
    adb.setCommandResponse(command, result(stdout));
  }
  return adb;
}

function setup(adb: FakeAdbExecutor, classify: (output: string) => ActionableError | null) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const emulator: BootedDevice = {
    name: "Pixel_9",
    platform: "android",
    deviceId: "emulator-5554",
  };
  const host: EmulatorReadinessHost = {
    timer: () => timer,
    adbFactory: () => new FakeAdbClientFactory(adb),
    getLaunchError: () => undefined,
    getLaunchErrorFinalization: () => undefined,
    throwLaunchError: () => {},
    getLaunchTargetDeviceId: () => undefined,
    captureLaunchTargetDeviceId: () => {},
    clearOfflineTracker: () => {},
    detectOfflineFailure: async () => null,
    maybeRecoverFreshOffline: async () => {},
    nextPollingDelayMs: (_tracker, _options, _id, _now, interval) => interval,
    getBootedDevicesWithDiagnostics: async () => ({ devices: [emulator], diagnostics: [] }),
    findNamedEmulator: (_name, _child, running) => ({ emulator: running[0] }),
    resolvedReadyAvdName: async (avdName) => avdName,
    resolveFoundDeviceModel: async () => "Pixel",
    foundBootedDevice: (name, deviceId, model) => ({ name, deviceId, platform: "android", model }),
    classifyEmulatorExitOutput: classify,
  };
  return { timer, poller: new DefaultEmulatorReadinessPoller(host) };
}

describe("DefaultEmulatorReadinessPoller", () => {
  test("returns the booted device once every readiness signal passes", async () => {
    const { poller } = setup(readyAdb(), () => null);

    const device = await poller.waitForEmulatorReady("Pixel_9", 5_000, null, undefined, undefined, {
      skipWakeAndUnlock: true,
    });

    expect(device).toEqual({
      name: "Pixel_9",
      deviceId: "emulator-5554",
      platform: "android",
      model: "Pixel",
    });
  });

  test("times out naming the unmet readiness predicate on the fake clock", async () => {
    const { poller, timer } = setup(
      readyAdb({ "shell getprop sys.boot_completed": "0\n" }),
      () => null,
    );

    await expect(
      poller.waitForEmulatorReady("Pixel_9", 3_000, null, undefined, undefined, {
        skipWakeAndUnlock: true,
      }),
    ).rejects.toThrow(/failed to become ready within 3000ms[\s\S]*phase=system-boot-complete/);
    expect(timer.now()).toBeGreaterThanOrEqual(3_000);
  });

  test("a process exit during readiness surfaces the host's classified failure", async () => {
    const adb = readyAdb({ "shell getprop sys.boot_completed": "0\n" });
    const classified = new ActionableError("Emulator failed to start: corrupt image");
    const { poller } = setup(adb, (output) => (output.includes("corrupt") ? classified : null));
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout,
      stderr: new EventEmitter(),
    }) as HostChildProcess;

    const pending = poller.waitForEmulatorReady("Pixel_9", 60_000, child, undefined, undefined, {
      skipWakeAndUnlock: true,
    });
    await Promise.resolve();
    stdout.emit("data", "corrupt system image");
    child.emit("exit", 1);

    await expect(pending).rejects.toBe(classified);
  });

  test("an already-aborted signal rejects with its reason", async () => {
    const { poller } = setup(readyAdb(), () => null);
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);

    await expect(
      poller.waitForEmulatorReady("Pixel_9", 5_000, null, undefined, controller.signal, {
        skipWakeAndUnlock: true,
      }),
    ).rejects.toBe(reason);
  });
});

describe("resolveEmulatorPollingInterval", () => {
  test("defaults, clamps and rejects out-of-range values", () => {
    expect(resolveEmulatorPollingInterval(undefined)).toBe(500);
    expect(resolveEmulatorPollingInterval("abc")).toBe(500);
    expect(resolveEmulatorPollingInterval("-5")).toBe(500);
    expect(resolveEmulatorPollingInterval("99999999999")).toBe(500);
    expect(resolveEmulatorPollingInterval("10")).toBe(100);
    expect(resolveEmulatorPollingInterval("2000")).toBe(2000);
  });
});
