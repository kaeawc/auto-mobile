import { describe, expect, test } from "bun:test";
import { ActionableError, type BootedDevice, type ExecResult } from "../../../src/models";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import {
  DefaultEmulatorReadinessPoller,
  resolveEmulatorPollingInterval,
  type EmulatorReadinessHost,
  type OfflineTracker,
} from "../../../src/utils/android-cmdline-tools/EmulatorReadinessPoller";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";
import { FakeDeviceExecutionBinding } from "../../fakes/FakeDeviceExecutionBinding";

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

function setup(
  adb: FakeAdbExecutor,
  classify: (output: string) => ActionableError | null,
  { autoAdvance = true }: { autoAdvance?: boolean } = {},
) {
  const timer = new FakeTimer();
  if (autoAdvance) {
    timer.enableAutoAdvance();
  }
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
    nextPollingDelayMs: (_tracker, _options, _id, budget) =>
      Math.min(budget.pollingIntervalMs, budget.remainingPollingTimeMs),
    getBootedDevicesWithDiagnostics: async () => ({ devices: [emulator], diagnostics: [] }),
    findNamedEmulator: (_name, _child, running) => ({ emulator: running[0] }),
    resolvedReadyAvdName: async (avdName) => avdName,
    resolveFoundDeviceModel: async () => "Pixel",
    foundBootedDevice: (name, deviceId, model) => ({ name, deviceId, platform: "android", model }),
    classifyEmulatorExitOutput: classify,
  };
  return { timer, adb, host, poller: new DefaultEmulatorReadinessPoller(host) };
}

describe("DefaultEmulatorReadinessPoller", () => {
  for (const correlation of ["launch-output", "avd-name"]) {
    for (const quarantined of [false, true]) {
      test(`binds only the correlated target during boot: ${correlation}, quarantined=${quarantined}`, async () => {
        const { timer, adb, host } = setup(
          readyAdb({ "shell getprop sys.boot_completed": "0\n" }),
          () => null,
          { autoAdvance: false },
        );
        const binding = new FakeDeviceExecutionBinding();
        const target: BootedDevice = {
          name: "Pixel_9",
          deviceId: "emulator-5558",
          platform: "android",
        };
        const unrelated: BootedDevice = {
          name: "Other",
          deviceId: "emulator-5556",
          platform: "android",
        };
        const admitted: string[] = [];
        const expectedBindings = quarantined ? [] : [target.deviceId];
        const poller = new DefaultEmulatorReadinessPoller(host, undefined, {
          executionBinding: binding,
          admissionGate: {
            assertDeviceActionable: (id) => {
              admitted.push(id);
              if (quarantined) {
                throw new ActionableError("Device identity is quarantined");
              }
            },
          },
        });
        host.getLaunchTargetDeviceId = () =>
          correlation === "launch-output" ? target.deviceId : undefined;
        // Launch correlation must bind even before the target appears in discovery.
        host.getBootedDevicesWithDiagnostics = async () => {
          if (correlation === "launch-output") {
            expect(binding.deviceIds).toEqual(expectedBindings);
          }
          return {
            devices: correlation === "launch-output" ? [unrelated] : [unrelated, target],
            diagnostics: [],
          };
        };
        host.findNamedEmulator = (name, _child, devices) => ({
          emulator: devices.find((device) => device.name === name),
        });
        host.adbFactory = () => ({
          create: (device) => {
            if (device) {
              // Name correlation must bind before the first selected-device probe.
              expect(device.deviceId).toBe(target.deviceId);
              expect(binding.deviceIds).toEqual(expectedBindings);
            }
            return adb;
          },
        });
        const controller = new AbortController();
        const reason = new Error("test completed before readiness");
        const pending = poller
          .waitForEmulatorReady("Pixel_9", 5_000, null, {
            signal: controller.signal,
          })
          .catch((error: unknown) => error);
        await drainMicrotasks(200);
        controller.abort(reason);
        expect(await pending).toBe(reason);
        expect(binding.deviceIds).toEqual(expectedBindings);
        expect(admitted).toEqual([target.deviceId]);
        expect(timer.now()).toBe(0);
        expect(timer.getPendingTimeoutCount()).toBe(0);
      });
    }
  }

  test("abort during both readiness sleeps rejects promptly without leaving timers", async () => {
    const { poller, timer } = setup(
      readyAdb({ "shell getprop sys.boot_completed": "0\n" }),
      () => null,
    );
    const controller = new AbortController();
    const reason = new Error("cancelled during readiness sleep");
    timer.setTimeout(() => controller.abort(reason), 120);

    await expect(
      poller.waitForEmulatorReady("Pixel_9", 5_000, null, { signal: controller.signal }),
    ).rejects.toBe(reason);

    expect(timer.now()).toBe(120);
    expect(timer.getPendingSleepCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getPendingIntervalCount()).toBe(0);
  });

  test("a classified process exit wakes both readiness sleeps immediately", async () => {
    const classified = new ActionableError("Emulator failed to start: corrupt image");
    const { poller, timer } = setup(
      readyAdb({ "shell getprop sys.boot_completed": "0\n" }),
      () => classified,
    );
    const child = new FakeChildProcess(timer);
    timer.setTimeout(() => {
      child.emit("exit", 1);
      child.emit("exit", 1);
    }, 120);

    await expect(poller.waitForEmulatorReady("Pixel_9", 5_000, child)).rejects.toBe(classified);

    console.log(`process exit at 120ms: caller released at ${timer.now()}ms`);
    expect(timer.now()).toBe(120);
    expect(timer.getPendingSleepCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getPendingIntervalCount()).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  test("a process exit awaiting finalization does not restart the sleeping poller (#14430)", async () => {
    const classified = new ActionableError("Emulator failed to start: corrupt image");
    const { poller, timer, host } = setup(
      readyAdb({ "shell getprop sys.boot_completed": "0\n" }),
      () => classified,
      { autoAdvance: false },
    );
    const child = new FakeChildProcess(timer);
    const finalization = Promise.withResolvers<ActionableError | undefined>();
    host.getLaunchErrorFinalization = (cp) =>
      cp === child && timer.now() >= 120 ? finalization.promise : undefined;
    // Any scan started after the exit hangs, as a real one bounded only by the
    // caller's signal can for up to the 10 s probe budget.
    const scanGate = Promise.withResolvers<void>();
    let scansAfterExit = 0;
    const scan = host.getBootedDevicesWithDiagnostics;
    host.getBootedDevicesWithDiagnostics = async (...args) => {
      if (timer.now() >= 120) {
        scansAfterExit++;
        await scanGate.promise;
      }
      return scan(...args);
    };
    let outcome: { error: unknown } | undefined;
    const pending = poller
      .waitForEmulatorReady("Pixel_9", 5_000, child)
      .then(() => ({ error: undefined }))
      .catch((error: unknown) => ({ error }));
    void pending.then((settled) => {
      outcome = settled;
    });

    // First poll completes; both loops are now asleep on their 500 ms timers.
    await drainMicrotasks(200);
    timer.setTimeout(() => child.emit("exit", 1), 120);
    timer.advanceTime(120);
    await drainMicrotasks(200);
    finalization.resolve(classified);
    await drainMicrotasks(200);

    const settledPromptly = outcome;
    scanGate.resolve();
    await pending;
    expect(scansAfterExit).toBe(0);
    expect(settledPromptly).toEqual({ error: classified });
    expect(timer.now()).toBe(120);
    expect(timer.getPendingSleepCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  test("a non-fatal exit settlement releases the parked poller immediately (#14430)", async () => {
    const { poller, timer, host } = setup(
      readyAdb({ "shell getprop sys.boot_completed": "0\n" }),
      () => new ActionableError("Emulator exited during readiness"),
      { autoAdvance: false },
    );
    const child = new FakeChildProcess(timer);
    const finalization = Promise.withResolvers<ActionableError | undefined>();
    host.getLaunchErrorFinalization = (cp) =>
      cp === child && timer.now() >= 120 ? finalization.promise : undefined;
    let scansAfterExit = 0;
    const scan = host.getBootedDevicesWithDiagnostics;
    host.getBootedDevicesWithDiagnostics = async (...args) => {
      scansAfterExit += timer.now() >= 120 ? 1 : 0;
      return scan(...args);
    };
    const controller = new AbortController();
    const reason = new Error("test finished");
    // Bun's `expect(...).rejects` blocks until settlement, so capture the rejection as a value.
    const pending = poller
      .waitForEmulatorReady("Pixel_9", 5_000, child, { signal: controller.signal })
      .then(() => undefined)
      .catch((error: unknown) => error);

    await drainMicrotasks(200);
    timer.setTimeout(() => child.emit("exit", 1), 120);
    timer.advanceTime(120);
    await drainMicrotasks(200);
    expect(scansAfterExit).toBe(0);
    // The launcher adopted the exit as another process's duplicate AVD.
    finalization.resolve(undefined);
    await drainMicrotasks(200);

    expect(scansAfterExit).toBe(1);
    expect(timer.now()).toBe(120);
    controller.abort(reason);
    expect(await pending).toBe(reason);
  });

  test("a launch failure recorded by the poller wakes the caller immediately", async () => {
    const failure = new ActionableError("Emulator failed to start: launch failure");
    const { poller, timer, host } = setup(
      readyAdb({ "shell getprop sys.boot_completed": "0\n" }),
      () => null,
    );
    host.nextPollingDelayMs = () => 120;
    host.getLaunchError = () => (timer.now() >= 120 ? failure : undefined);

    await expect(poller.waitForEmulatorReady("Pixel_9", 5_000)).rejects.toBe(failure);

    expect(timer.now()).toBe(120);
    expect(timer.getPendingSleepCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getPendingIntervalCount()).toBe(0);
  });

  test("process exit keeps precedence when the in-flight readiness probes also succeed", async () => {
    const failure = new ActionableError("Emulator failed to start: corrupt image");
    const { poller, timer, host } = setup(readyAdb(), () => failure);
    const child = new FakeChildProcess(timer);
    const scan = host.getBootedDevicesWithDiagnostics;
    host.getBootedDevicesWithDiagnostics = async () => {
      timer.advanceTime(120);
      child.emit("exit", 1);
      return scan();
    };

    await expect(poller.waitForEmulatorReady("Pixel_9", 5_000, child)).rejects.toBe(failure);

    expect(timer.now()).toBe(120);
    expect(timer.getPendingSleepCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getPendingIntervalCount()).toBe(0);
  });

  test("a terminal poller failure wakes the caller with the original thrown value", async () => {
    for (const failure of [new Error("polling delay calculation failed"), undefined]) {
      const { poller, timer, host } = setup(
        readyAdb({ "shell getprop sys.boot_completed": "0\n" }),
        () => null,
      );
      host.nextPollingDelayMs = () => {
        timer.advanceTime(120);
        throw failure;
      };
      const child = new FakeChildProcess(timer);

      await expect(poller.waitForEmulatorReady("Pixel_9", 5_000, child)).rejects.toBe(failure);

      expect(timer.now()).toBe(120);
      expect(timer.getPendingSleepCount()).toBe(0);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(timer.getPendingIntervalCount()).toBe(0);
      expect(child.listenerCount("exit")).toBe(0);
    }
  });

  test("nothing ready times out at a deadline between fallback ticks without leaving timers", async () => {
    const { poller, timer } = setup(
      readyAdb({ "shell getprop sys.boot_completed": "0\n" }),
      () => null,
    );

    await expect(poller.waitForEmulatorReady("Pixel_9", 750)).rejects.toThrow(
      /failed to become ready within 750ms[\s\S]*phase=system-boot-complete/,
    );

    expect(timer.now()).toBe(750);
    expect(timer.getPendingSleepCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getPendingIntervalCount()).toBe(0);
  });

  test("returns the booted device once every readiness signal passes", async () => {
    const { poller, timer } = setup(readyAdb(), () => null);

    const device = await poller.waitForEmulatorReady("Pixel_9", 5_000, null, {
      options: { skipWakeAndUnlock: true },
    });

    // The caller is released when the poller finishes, not on the 500 ms fallback tick.
    expect(timer.now()).toBeLessThan(500);

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
      poller.waitForEmulatorReady("Pixel_9", 3_000, null, { options: { skipWakeAndUnlock: true } }),
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

    const pending = poller.waitForEmulatorReady("Pixel_9", 60_000, child, {
      options: { skipWakeAndUnlock: true },
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
      poller.waitForEmulatorReady("Pixel_9", 5_000, null, {
        signal: controller.signal,
        options: { skipWakeAndUnlock: true },
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
