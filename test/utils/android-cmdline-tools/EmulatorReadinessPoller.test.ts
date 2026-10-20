import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { describe, expect, test } from "bun:test";
import { ActionableError, type BootedDevice, type ExecResult } from "../../../src/models";
import {
  DefaultEmulatorReadinessPoller,
  resolveEmulatorPollingInterval,
  type EmulatorReadinessHost,
  type OfflineTracker,
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
    maybeRecoverFreshOffline: async () => {},
    nextPollingDelayMs: (_tracker, _options, _id, _now, interval) => interval,
    getBootedDevicesWithDiagnostics: async () => ({ devices: [emulator], diagnostics: [] }),
    findNamedEmulator: (_name, _child, running) => ({ emulator: running[0] }),
    resolvedReadyAvdName: async (avdName) => avdName,
    resolveFoundDeviceModel: async () => "Pixel",
    foundBootedDevice: (name, deviceId, model) => ({ name, deviceId, platform: "android", model }),
    classifyEmulatorExitOutput: classify,
  };
  return { timer, adb, poller: new DefaultEmulatorReadinessPoller(host) };
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
    const child = new FakeChildProcess();
    child.pid = 4242;
    const stdout = child.stdout;

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

describe("DefaultEmulatorReadinessPoller.detectOfflineFailure", () => {
  test("clears a stale offline diagnosis when the target recovers", async () => {
    const adb = readyAdb();
    const { timer, poller } = setup(adb, () => null);
    const tracker: OfflineTracker = { deviceId: null, since: null, recoveryAttempted: false };

    adb.setDeviceStates([{ deviceId: "emulator-5554", state: "offline" }]);
    await poller.detectOfflineFailure("emulator-5554", tracker);
    expect(tracker.since).toBe(0);
    expect(tracker.state).toBe("offline");
    timer.advanceTime(15_000);
    expect(await poller.detectOfflineFailure("emulator-5554", tracker)).toBeNull();
    expect(tracker.since).toBe(0);

    adb.setDeviceStates([{ deviceId: "emulator-5554", state: "device" }]);
    expect(await poller.detectOfflineFailure("emulator-5554", tracker)).toBeNull();
    expect(tracker.since).toBeNull();
    expect(tracker.state).toBe("not-ready");
  });

  test("a rejected state probe clears the current observation", async () => {
    const adb = readyAdb();
    adb.getDeviceStates = async () => {
      throw new Error("probe unavailable");
    };
    const { poller } = setup(adb, () => null);
    const tracker: OfflineTracker = {
      deviceId: "emulator-5554",
      since: 5,
      state: "offline",
      recoveryAttempted: true,
    };
    expect(await poller.detectOfflineFailure("emulator-5554", tracker)).toBeNull();
    expect(tracker.deviceId).toBeNull();
    expect(tracker.since).toBeNull();
    expect(tracker.recoveryAttempted).toBe(true);
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
