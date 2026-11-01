import { ActionableError } from "../../../src/models/ActionableError";
import { AdbCommandTimeoutError } from "../../../src/utils/android-cmdline-tools/AdbCommandTimeoutError";
import { SETTINGS_TIMEOUT, CTRL_PROXY_FAILED } from "./fixtures/androidResetLoadTimeouts";
import { describe, expect, test } from "bun:test";
import {
  NativeAndroidSnapshotResetPort,
  type AndroidSnapshotNativeDependencies,
} from "../../../src/daemon/sessionBroker/androidSnapshotResetNativePort";
import type { AndroidSnapshotStep } from "../../../src/daemon/sessionBroker/androidSnapshotReset";
import { InMemoryEmulatorConsoleBusyRegistry } from "../../../src/utils/android-cmdline-tools/EmulatorConsoleBusyRegistry";
import { ANDROID_BROKER_BASELINE_SNAPSHOT } from "../../../src/utils/snapshotNameValidation";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ANDROID_RESET_DEVICE } from "./fixtures/androidReset";
import { drainMicrotasks, drainUntil } from "../../helpers/fakeTimerStepping";
import { resolveRunningAvdNameOnce } from "../../../src/utils/android-cmdline-tools/runningAvdName";
import { DeviceClockRestoreRegistry } from "../../../src/features/utility/DeviceClock";
import { FakeEmulatorProcessStopper } from "../../fakes/FakeEmulatorProcessStopper";

function nativeRig() {
  const timer = new FakeTimer();
  const adb = new FakeAdbClient();
  const process = new FakeChildProcess(timer);
  const launches: Parameters<AndroidSnapshotNativeDependencies["emulator"]["launchEmulator"]>[0][] =
    [];
  const console = new InMemoryEmulatorConsoleBusyRegistry();
  const identityAdb = new FakeAdbClient();
  identityAdb.setCommandResult("emu avd name", ANDROID_RESET_DEVICE.name);
  const identityFactory = new FakeAdbClientFactory(identityAdb);
  const processStopper = new FakeEmulatorProcessStopper();
  const clockRegistry = new DeviceClockRestoreRegistry();
  let quickBootCleared = false;
  let owned = true;
  let healthy = true;
  let metadata = "Pkg.Revision=1";
  let stopped = false;
  let killCalls = 0;
  const step: AndroidSnapshotStep = {
    signal: new AbortController().signal,
    timeoutMs: 1000,
    assertOwned: async () => {
      if (!owned) {
        throw new Error("ownership lost");
      }
    },
  };
  const dependencies: AndroidSnapshotNativeDependencies = {
    timer,
    adb: new FakeAdbClientFactory(adb),
    console,
    clockRegistry,
    processStopper,
    clearQuickBoot: async (_device, step) => {
      await step.assertOwned();
      quickBootCleared = true;
    },
    config: new FakeAvdConfigReader({
      systemImagePackage: "system-images;android-35;google_apis;arm64-v8a",
      systemImagePath: "system-images/android-35/google_apis/arm64-v8a/",
      hardware: {},
    }),
    capacity: {
      reserveBoot: async () => ({
        run: async (operation) => operation(),
        release: () => {},
        markReplacedDeviceGone: () => {},
      }),
    },
    admitColdBoot: async () => ({ handOff: () => {}, release: () => {} }),
    imageMetadata: async () => metadata,
    invalidate: () => {},
    ctrlProxyReady: async () => healthy,
    inventory: async () => (stopped ? [] : [ANDROID_RESET_DEVICE]),
    readiness: { ready: async () => {}, ctrlProxyIdentity: async () => "verified-ctrlproxy-sha" },
    emulator: {
      executeCommand: async () => createExecResult("Android emulator version 36.1", ""),
      resolveAvdNameForSerial: async (serial, options) => {
        const result = await resolveRunningAvdNameOnce(
          { consoleBusyRegistry: console, adbFactory: identityFactory, timer },
          { ...ANDROID_RESET_DEVICE, deviceId: serial },
          options.timeoutMs,
          { signal: options.signal, consoleExclusiveOwner: options.consoleExclusiveOwner },
        );
        if (options.throwOnTimeout && result.nameProbeTimedOut) {
          throw new AdbCommandTimeoutError(`AVD name timed out after ${options.timeoutMs}ms`);
        }
        return result.name || undefined;
      },
      getListedNonDeviceStatesAmong: async () => new Map(),
      killDevice: async (device, options) => {
        killCalls += 1;
        await options?.beforeDispatch?.();
        stopped = true;
        return device;
      },
      launchEmulator: async (request) => {
        launches.push(request);
        await request.admitColdBoot?.();
        const abort = () => {
          process.kill();
        };
        request.signal?.addEventListener("abort", abort, { once: true });
        return {
          avdName: request.avdName,
          process,
          outcome: "launched",
          targetDeviceId: request.deviceId,
          dispose: () => process.kill(),
          release: () => request.signal?.removeEventListener("abort", abort),
        };
      },
      waitForEmulatorReady: async () => ANDROID_RESET_DEVICE,
    },
  };
  const port = new NativeAndroidSnapshotResetPort(dependencies);
  return {
    timer,
    port,
    adb,
    step,
    dependencies,
    launches,
    console,
    identityAdb,
    processStopper,
    clockRegistry,
    process,
    quickBootCleared: () => quickBootCleared,
    killCalls: () => killCalls,
    loseOwnership: () => {
      owned = false;
    },
    changeAvd: () => {
      identityAdb.setCommandResult("emu avd name", "foreign-avd");
    },
    failHealth: () => {
      healthy = false;
    },
    changeImageRevision: () => {
      metadata = "Pkg.Revision=2";
    },
  };
}

function healthyClock(adb: FakeAdbClient): void {
  adb.setCommandResult("shell getprop sys.boot_completed", "1");
  adb.setCommandResult("shell id", "uid=0(root)");
  adb.setCommandResult("shell settings get global auto_time", "1");
  adb.setCommandResult("shell date +%s", "0");
}

describe("NativeAndroidSnapshotResetPort", () => {
  test.each(["save", "load", "delete"] as const)(
    "%s verifies identity through the real busy registry resolver",
    async (action) => {
      const { port, step, adb, console, identityAdb } = nativeRig();
      const command = `emu avd snapshot ${action === "delete" ? "del" : action} ${ANDROID_BROKER_BASELINE_SNAPSHOT}`;
      adb.setCommandResult(command, "OK");
      await port.snapshot(action, ANDROID_RESET_DEVICE, step);
      expect(identityAdb.getCommandCalls().map((call) => call.command)).toEqual(["emu avd name"]);
      expect(adb.getCommandCalls().map((call) => call.command)).toEqual([command]);
      expect(console.isBusy(ANDROID_RESET_DEVICE.deviceId)).toBe(false);
    },
  );

  test("stop forces the identified broker runtime and proves its process exited", async () => {
    const { port, step, dependencies, processStopper, quickBootCleared } = nativeRig();
    processStopper.identities = [
      {
        kind: "match",
        pid: 4242,
        avdName: ANDROID_RESET_DEVICE.name,
        port: 5554,
        command: "qemu-system-aarch64 -avd broker-avd -port 5554",
      },
    ];
    dependencies.emulator.killDevice = async (device, options) => {
      expect(options?.force).toBe(true);
      await options?.beforeDispatch?.();
      return device;
    };
    dependencies.inventory = async () => [];
    await port.stop(ANDROID_RESET_DEVICE, step);
    expect(quickBootCleared()).toBe(true);
  });

  test("forced stop refuses success while the identified process stays alive", async () => {
    const { port, step, timer, processStopper, quickBootCleared } = nativeRig();
    timer.enableAutoAdvance();
    processStopper.identity = {
      kind: "match",
      pid: 4242,
      avdName: ANDROID_RESET_DEVICE.name,
      port: 5554,
      command: "qemu-system-aarch64 -avd broker-avd -port 5554",
    };
    await expect(port.stop(ANDROID_RESET_DEVICE, step)).rejects.toThrow(
      "did not exit before the deadline",
    );
    expect(quickBootCleared()).toBe(false);
    expect(timer.now()).toBe(step.timeoutMs);
  });

  test("stop waits for the process after adb disappears and removes dirty quick-boot state", async () => {
    const { port, step, timer, processStopper, quickBootCleared } = nativeRig();
    processStopper.identity = {
      kind: "match",
      pid: 4242,
      avdName: ANDROID_RESET_DEVICE.name,
      port: 5554,
      command: "emulator -avd broker-avd",
    };
    let finished = false;
    const stopping = port.stop(ANDROID_RESET_DEVICE, step).then(() => {
      finished = true;
    });
    await drainUntil(() => timer.getPendingSleepCount() > 0, {
      description: "process exit polling",
    });
    expect(finished).toBe(false);
    expect(quickBootCleared()).toBe(false);
    processStopper.identity = { kind: "absent" };
    timer.advanceTime(100);
    await stopping;
    expect(quickBootCleared()).toBe(true);
  });

  test.each(["inventory", "listed states"])(
    "stop retries failed %s polls until absence is proven",
    async (poll) => {
      const { port, step, timer, dependencies, processStopper, quickBootCleared } = nativeRig();
      timer.enableAutoAdvance();
      processStopper.identities = [
        {
          kind: "match",
          pid: 4242,
          avdName: ANDROID_RESET_DEVICE.name,
          port: 5554,
          command: "emulator -avd broker-avd",
        },
      ];
      let calls = 0;
      const read = async () => {
        if (++calls <= 2) {
          throw new Error("Android baseline reset inventory timed out after 2000ms");
        }
      };
      dependencies.inventory = async () => {
        if (poll === "inventory") {
          await read();
        }
        return [];
      };
      dependencies.emulator.getListedNonDeviceStatesAmong = async () => {
        if (poll === "listed states") {
          await read();
        }
        return new Map();
      };
      await expect(port.stop(ANDROID_RESET_DEVICE, step)).resolves.toBeUndefined();
      expect(calls).toBe(3);
      expect(quickBootCleared()).toBe(true);
    },
  );

  test("stop fails closed at the exit deadline with the last poll error", async () => {
    const { port, step, timer, dependencies, processStopper, quickBootCleared } = nativeRig();
    timer.enableAutoAdvance();
    processStopper.identities = [
      {
        kind: "match",
        pid: 4242,
        avdName: ANDROID_RESET_DEVICE.name,
        port: 5554,
        command: "emulator -avd broker-avd",
      },
    ];
    dependencies.inventory = async () => {
      throw new Error("inventory unavailable");
    };
    await expect(port.stop(ANDROID_RESET_DEVICE, step)).rejects.toThrow(
      "did not exit before the deadline: inventory unavailable",
    );
    expect(timer.now()).toBe(step.timeoutMs);
    expect(quickBootCleared()).toBe(false);
  });

  test("stop propagates an aborted poll promptly", async () => {
    const { port, step, timer, dependencies, processStopper } = nativeRig();
    const controller = new AbortController();
    processStopper.identities = [
      {
        kind: "match",
        pid: 4242,
        avdName: ANDROID_RESET_DEVICE.name,
        port: 5554,
        command: "emulator -avd broker-avd",
      },
    ];
    dependencies.inventory = async () => {
      controller.abort(new Error("stop cancelled"));
      throw controller.signal.reason;
    };
    await expect(
      port.stop(ANDROID_RESET_DEVICE, { ...step, signal: controller.signal }),
    ).rejects.toThrow("stop cancelled");
    expect(timer.getSleepCallCount()).toBe(0);
  });

  test("stop bounds each targeted read by the remaining exit budget", async () => {
    const { port, step, timer, dependencies, processStopper } = nativeRig();
    processStopper.identities = [
      {
        kind: "match",
        pid: 4242,
        avdName: ANDROID_RESET_DEVICE.name,
        port: 5554,
        command: "emulator -avd broker-avd",
      },
    ];
    dependencies.inventory = async (options) => {
      expect(options).toEqual({
        signal: step.signal,
        timeoutMs: 2000,
        targetDeviceId: ANDROID_RESET_DEVICE.deviceId,
      });
      timer.advanceTime(1500);
      return [];
    };
    dependencies.emulator.getListedNonDeviceStatesAmong = async (_ids, options) => {
      expect(options?.timeoutMs).toBe(2000);
      return new Map();
    };
    await port.stop(ANDROID_RESET_DEVICE, { ...step, timeoutMs: 6000 });
  });

  test("stop still propagates ownership loss after a failed poll", async () => {
    const { port, step, dependencies, processStopper, loseOwnership, timer } = nativeRig();
    processStopper.identities = [
      {
        kind: "match",
        pid: 4242,
        avdName: ANDROID_RESET_DEVICE.name,
        port: 5554,
        command: "emulator -avd broker-avd",
      },
    ];
    dependencies.inventory = async () => {
      loseOwnership();
      throw new Error("inventory unavailable");
    };
    await expect(port.stop(ANDROID_RESET_DEVICE, step)).rejects.toThrow("ownership lost");
    expect(timer.getSleepCallCount()).toBe(0);
  });

  test("an absent process lookup refuses stop as unprovable", async () => {
    const { port, step, processStopper, quickBootCleared, killCalls } = nativeRig();
    processStopper.identity = { kind: "absent" };

    await expect(port.stop(ANDROID_RESET_DEVICE, step)).rejects.toThrow("cannot prove");

    expect(processStopper.identifyCalls).toHaveLength(1);
    expect(killCalls()).toBe(0);
    expect(quickBootCleared()).toBe(false);
  });

  test.each(["unreadable", "ambiguous"] as const)(
    "%s process identity refuses cleanup and relaunch",
    async (kind) => {
      const { port, step, processStopper, quickBootCleared } = nativeRig();
      processStopper.identity =
        kind === "unreadable" ? { kind, detail: "ps failed" } : { kind, candidates: [] };
      await expect(port.stop(ANDROID_RESET_DEVICE, step)).rejects.toThrow("cannot prove");
      expect(quickBootCleared()).toBe(false);
    },
  );

  test("restore waits for the exact serial with restored display state preserved", async () => {
    const { port, step, dependencies } = nativeRig();
    const calls: Parameters<
      AndroidSnapshotNativeDependencies["emulator"]["waitForEmulatorReady"]
    >[] = [];
    dependencies.emulator.waitForEmulatorReady = async (...args) => {
      calls.push(args);
      return ANDROID_RESET_DEVICE;
    };
    await port.waitForRestore(ANDROID_RESET_DEVICE, step);
    expect(calls).toEqual([
      [
        ANDROID_RESET_DEVICE.name,
        step.timeoutMs,
        null,
        {
          targetDeviceId: ANDROID_RESET_DEVICE.deviceId,
          signal: expect.any(AbortSignal),
          options: { skipWakeAndUnlock: true },
        },
      ],
    ]);
  });

  describe("restore readiness against emulator death (#15177)", () => {
    function pendingRestore() {
      const rig = nativeRig();
      rig.step.timeoutMs = 600_000;
      const readinessSignals: AbortSignal[] = [];
      rig.dependencies.emulator.waitForEmulatorReady = (...args) => {
        const signal = args[3]?.signal;
        if (signal) {
          readinessSignals.push(signal);
        }
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      };
      const match = {
        kind: "match" as const,
        pid: 4242,
        avdName: ANDROID_RESET_DEVICE.name,
        port: 5554,
        command: "qemu-system",
      };
      const settled: { error?: unknown; done: boolean } = { done: false };
      const start = () => {
        const restore = rig.port.waitForRestore(ANDROID_RESET_DEVICE, rig.step);
        void restore.then(
          () => {
            settled.done = true;
          },
          (error: unknown) => {
            settled.error = error;
            settled.done = true;
          },
        );
        return restore;
      };
      const tick = async (ms: number) => {
        await drainUntil(() => rig.timer.getPendingSleeps().length > 0, {
          description: "liveness sleep",
        });
        rig.timer.advanceTime(ms);
        await drainMicrotasks(50);
      };
      return { ...rig, readinessSignals, match, settled, start, tick };
    }

    test("a dead emulator process fails the wait promptly instead of waiting out the budget", async () => {
      const { processStopper, match, settled, start, tick, readinessSignals, timer } =
        pendingRestore();
      processStopper.identities = [match, { kind: "absent" }, { kind: "absent" }];
      const restore = start();
      const startedAt = timer.now();
      await tick(500);
      expect(settled.done).toBe(false);
      await tick(1000);
      expect(settled.done).toBe(false);
      await tick(2000);
      await expect(restore).rejects.toThrow("exited during snapshot restore");
      expect(settled.error).toBeInstanceOf(ActionableError);
      expect(timer.now() - startedAt).toBe(3500);
      expect(readinessSignals[0]?.aborted).toBe(true);
    });

    test("an identity mismatch on the serial counts as the owned process being gone", async () => {
      const { processStopper, settled, start, tick } = pendingRestore();
      const mismatch = {
        kind: "mismatch" as const,
        pid: 7,
        runningAvdName: "foreign",
        port: 5554,
        command: "qemu-system",
      };
      processStopper.identities = [mismatch, { kind: "absent" }];
      const restore = start();
      await tick(500);
      await tick(1000);
      await expect(restore).rejects.toThrow("exited during snapshot restore");
      expect(settled.done).toBe(true);
    });

    test("one torn process-table read does not abort the wait", async () => {
      const { processStopper, match, settled, start, tick, readinessSignals } = pendingRestore();
      processStopper.identities = [{ kind: "absent" }, match, { kind: "absent" }];
      void start();
      await tick(500);
      await tick(1000);
      await tick(2000);
      expect(settled.done).toBe(false);
      expect(readinessSignals[0]?.aborted).toBe(false);
    });

    test("an unreadable process table never proves death", async () => {
      const { processStopper, settled, start, tick } = pendingRestore();
      processStopper.identity = { kind: "unreadable", detail: "ps failed" };
      void start();
      await tick(500);
      await tick(1000);
      await tick(2000);
      await tick(2000);
      expect(settled.done).toBe(false);
    });

    test("losing ownership during the wait fails it", async () => {
      const { processStopper, match, loseOwnership, start, tick } = pendingRestore();
      processStopper.identity = match;
      const restore = start();
      await tick(500);
      loseOwnership();
      await tick(1000);
      await expect(restore).rejects.toThrow("ownership lost");
    });

    test("readiness completing stops the liveness watch", async () => {
      const { processStopper, port, step, dependencies, timer } = nativeRig();
      let resolveReady: (() => void) | undefined;
      dependencies.emulator.waitForEmulatorReady = () =>
        new Promise((resolve) => {
          resolveReady = () => resolve(ANDROID_RESET_DEVICE);
        });
      const restore = port.waitForRestore(ANDROID_RESET_DEVICE, step);
      await drainUntil(() => resolveReady !== undefined, { description: "readiness started" });
      resolveReady?.();
      await restore;
      timer.advanceTime(10_000);
      await drainMicrotasks(50);
      expect(processStopper.identifyCalls).toHaveLength(0);
    });
  });

  test("replacement releases launch lifetime before readiness and survives later deadline abort", async () => {
    const { port, step, dependencies, process } = nativeRig();
    const controller = new AbortController();
    step.signal = controller.signal;
    dependencies.emulator.waitForEmulatorReady = async () => {
      controller.abort(new Error("reset deadline"));
      throw new Error("reset deadline");
    };
    await expect(port.launchWiped(ANDROID_RESET_DEVICE, step)).rejects.toThrow("reset deadline");
    expect(process.killed).toBe(false);
  });

  test("clock health honors root and transport timeout budgets and serializes with queued restores", async () => {
    const { port, step, adb, clockRegistry, timer } = nativeRig();
    step.timeoutMs = 180_000;
    healthyClock(adb);
    adb.setCommandResultSequence("shell id", [
      { stdout: "uid=2000(shell)", stderr: "" },
      { stdout: "uid=0(root)", stderr: "" },
      { stdout: "uid=2000(shell)", stderr: "" },
    ]);
    adb.setCommandResult("shell getprop ro.debuggable", "1");
    let release: (() => void) | undefined;
    const prior = clockRegistry.runExclusive(
      ANDROID_RESET_DEVICE.deviceId,
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await drainUntil(() => release !== undefined, { description: "prior clock restore" });
    const health = port.health(ANDROID_RESET_DEVICE, step);
    await drainUntil(
      () =>
        adb.getCommandCalls().some((call) => call.command === "shell getprop sys.boot_completed"),
      { description: "boot probe" },
    );
    expect(adb.getCommandCalls().some((call) => call.command === "root")).toBe(false);
    timer.advanceTime(5000);
    adb.setCommandResult("shell date +%s", "5");
    release?.();
    await prior;
    await health;
    expect(adb.getCommandCalls().find((call) => call.command === "root")?.timeoutMs).toBe(30_000);
    expect(
      adb
        .getCommandCalls()
        .filter((call) => call.command === "wait-for-device")
        .map((call) => call.timeoutMs),
    ).toEqual([60_000, 60_000]);
  });

  test("stop cannot mistake an offline transport for a disappeared emulator", async () => {
    const { port, step, dependencies, timer, processStopper } = nativeRig();
    processStopper.identity = {
      kind: "match",
      pid: 4242,
      avdName: ANDROID_RESET_DEVICE.name,
      port: 5554,
      command: "emulator -avd broker-avd",
    };
    let offline = true;
    let finished = false;
    dependencies.emulator.getListedNonDeviceStatesAmong = async () =>
      offline ? new Map([[ANDROID_RESET_DEVICE.deviceId, "offline"]]) : new Map();
    const stopping = port.stop(ANDROID_RESET_DEVICE, step).then(() => {
      finished = true;
    });
    await drainUntil(() => timer.getPendingSleepCount() > 0, { description: "shutdown polling" });
    expect(finished).toBe(false);
    offline = false;
    processStopper.identity = { kind: "absent" };
    timer.advanceTime(100);
    await stopping;
    expect(finished).toBe(true);
  });
  test("system-image revision is part of identity even when the SDK package is unchanged", async () => {
    const { port, step, changeImageRevision } = nativeRig();
    const first = await port.identity(ANDROID_RESET_DEVICE, step);
    changeImageRevision();
    expect((await port.identity(ANDROID_RESET_DEVICE, step)).systemImage).not.toBe(
      first.systemImage,
    );
  });

  test("snapshot console commands use the reserved name, one dispatch, cancellation and settlement", async () => {
    const { port, step, adb, console } = nativeRig();
    const command = `emu avd snapshot save ${ANDROID_BROKER_BASELINE_SNAPSHOT}`;
    adb.setCommandResult(command, "OK");
    await port.snapshot("save", ANDROID_RESET_DEVICE, step);
    expect(adb.getCommandCalls()).toMatchObject([
      { command, noRetry: true, signal: step.signal, waitForProcessSettlementAfterAbort: true },
    ]);
    expect(console.isBusy(ANDROID_RESET_DEVICE.deviceId)).toBe(false);
  });

  test("a recycled serial cannot save or overwrite the baseline", async () => {
    const { port, step, adb, changeAvd } = nativeRig();
    changeAvd();
    await expect(port.snapshot("save", ANDROID_RESET_DEVICE, step)).rejects.toThrow("owned AVD");
    expect(adb.getCommandCalls()).toHaveLength(0);
  });

  test("missing snapshot deletion is idempotent but failed load is not accepted", async () => {
    const { port, step, adb } = nativeRig();
    adb.setCommandResult(
      `emu avd snapshot del ${ANDROID_BROKER_BASELINE_SNAPSHOT}`,
      "KO: snapshot not found",
    );
    await port.snapshot("delete", ANDROID_RESET_DEVICE, step);
    adb.setCommandResult(
      `emu avd snapshot load ${ANDROID_BROKER_BASELINE_SNAPSHOT}`,
      "KO: snapshot not found",
    );
    await expect(port.snapshot("load", ANDROID_RESET_DEVICE, step)).rejects.toThrow(
      "snapshot not found",
    );
  });

  test("wipe-data launch uses the same AVD and serial and disables quick-boot restore", async () => {
    const { port, step, launches } = nativeRig();
    await port.launchWiped(ANDROID_RESET_DEVICE, step);
    expect(launches[0]).toMatchObject({
      avdName: ANDROID_RESET_DEVICE.name,
      deviceId: ANDROID_RESET_DEVICE.deviceId,
      extraArgs: ["-wipe-data", "-no-snapshot-load", "-no-snapshot-save"],
      signal: step.signal,
    });
  });

  test("mismatched wipe-data launch disposes its child process", async () => {
    const { port, step, dependencies, process } = nativeRig();
    let disposed = false;
    dependencies.emulator.launchEmulator = async (request) => ({
      avdName: request.avdName,
      process,
      outcome: "launched",
      targetDeviceId: "emulator-5556",
      dispose: () => {
        disposed = true;
        process.kill();
      },
      release: () => {},
    });

    await expect(port.launchWiped(ANDROID_RESET_DEVICE, step)).rejects.toThrow(
      "exact reserved emulator",
    );

    expect(disposed).toBe(true);
    expect(process.killed).toBe(true);
  });

  test("health verifies completed boot, real-time clock readback, and CtrlProxy", async () => {
    const { port, step, adb } = nativeRig();
    healthyClock(adb);
    await port.health(ANDROID_RESET_DEVICE, step);
    expect(adb.getCommandCalls().map((call) => call.command)).toContain("shell date -u @0");
  });

  test("CtrlProxy failure cannot pass health after a successful snapshot load", async () => {
    const { port, step, adb, failHealth, timer } = nativeRig();
    timer.enableAutoAdvance();
    healthyClock(adb);
    failHealth();
    await expect(port.health(ANDROID_RESET_DEVICE, step)).rejects.toThrow("CtrlProxy health check");
  });

  test("clock drift or incomplete boot fails closed", async () => {
    const { port, step, adb } = nativeRig();
    healthyClock(adb);
    adb.setCommandResult("shell getprop sys.boot_completed", "0");
    await expect(port.health(ANDROID_RESET_DEVICE, step)).rejects.toThrow("completed boot");
    adb.setCommandResult("shell getprop sys.boot_completed", "1");
    adb.setCommandResult("shell date +%s", "10");
    await expect(port.health(ANDROID_RESET_DEVICE, step)).rejects.toThrow("clock resync");
  });

  test("ownership loss refuses every native mutation", async () => {
    const { port, step, adb, launches, loseOwnership } = nativeRig();
    loseOwnership();
    await expect(port.snapshot("load", ANDROID_RESET_DEVICE, step)).rejects.toThrow(
      "ownership lost",
    );
    await expect(port.stop(ANDROID_RESET_DEVICE, step)).rejects.toThrow("ownership lost");
    await expect(port.launchWiped(ANDROID_RESET_DEVICE, step)).rejects.toThrow("ownership lost");
    expect(adb.getCommandCalls()).toHaveLength(0);
    expect(launches).toHaveLength(0);
  });
});

describe("snapshot health under load", () => {
  test.each([60_000, 20_000])(
    "clock and root floors clamp to %i ms remaining",
    async (remaining) => {
      const { port, step, adb } = nativeRig();
      step.timeoutMs = remaining;
      healthyClock(adb);
      adb.setCommandResultSequence("shell id", [
        { stdout: "uid=2000(shell)", stderr: "" },
        { stdout: "uid=0(root)", stderr: "" },
      ]);
      adb.setCommandResult("shell getprop ro.debuggable", "1");
      await port.health(ANDROID_RESET_DEVICE, step);
      for (const command of ["shell id", "root", "unroot", "shell date -u @0"]) {
        const calls = adb.getCommandCalls().filter((call) => call.command === command);
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0]?.timeoutMs).toBe(Math.min(30_000, remaining));
      }
      expect(
        adb
          .getCommandCalls()
          .filter((call) => call.command === "wait-for-device")
          .map((call) => call.timeoutMs),
      ).toEqual([remaining, remaining]);
    },
  );

  test.each([60_000, 20_000])(
    "timestamped date write gets one attempt within %i ms",
    async (remaining) => {
      const { port, step, adb, timer } = nativeRig();
      timer.enableAutoAdvance();
      step.timeoutMs = remaining;
      healthyClock(adb);
      adb.setCommandError("shell date -u @0", new AdbCommandTimeoutError(SETTINGS_TIMEOUT));
      await expect(port.health(ANDROID_RESET_DEVICE, step)).rejects.toThrow(SETTINGS_TIMEOUT);
      const calls = adb.getCommandCalls().filter((call) => call.command === "shell date -u @0");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.timeoutMs).toBe(Math.min(30_000, remaining));
      expect(timer.getSleepHistory()).toEqual([]);
    },
  );

  test.each([
    "root",
    "unroot",
    "wait-for-device",
    "shell date +%s",
    "shell settings put global auto_time 1",
  ])("%s retries a transient timeout because it is idempotent", async (target) => {
    const { port, step, adb, timer } = nativeRig();
    timer.enableAutoAdvance();
    step.timeoutMs = 60_000;
    healthyClock(adb);
    adb.setCommandResultSequence("shell id", [
      { stdout: "uid=2000(shell)", stderr: "" },
      { stdout: "uid=0(root)", stderr: "" },
    ]);
    adb.setCommandResult("shell getprop ro.debuggable", "1");
    const execute = adb.executeCommand.bind(adb);
    let attempts = 0;
    const timeouts: number[] = [];
    adb.executeCommand = async (command, options) => {
      if (command === target) {
        timeouts.push(options?.timeoutMs ?? 0);
        if (++attempts === 1) {
          throw new AdbCommandTimeoutError(SETTINGS_TIMEOUT);
        }
      }
      return execute(command, options);
    };
    await port.health(ANDROID_RESET_DEVICE, step);
    // wait-for-device also runs after unroot; all others have one successful retry.
    expect(attempts).toBe(target === "wait-for-device" ? 3 : 2);
    expect(timeouts[0]).toBe(target === "wait-for-device" ? 60_000 : 30_000);
    expect(timer.getSleepHistory()).toEqual([250]);
  });

  test("CtrlProxy false twice then true recovers within its window", async () => {
    const { port, step, adb, timer, dependencies } = nativeRig();
    timer.enableAutoAdvance();
    step.timeoutMs = 600_000;
    healthyClock(adb);
    let calls = 0;
    dependencies.ctrlProxyReady = async () => ++calls >= 3;
    await port.health(ANDROID_RESET_DEVICE, step);
    expect(calls).toBe(3);
    expect(timer.getSleepHistory()).toEqual([250, 500]);
  });
  test("CtrlProxy stays false until its derived window expires", async () => {
    const { port, step, adb, timer, dependencies } = nativeRig();
    timer.enableAutoAdvance();
    step.timeoutMs = 600_000;
    healthyClock(adb);
    let calls = 0;
    dependencies.ctrlProxyReady = async () => {
      calls++;
      return false;
    };
    await expect(port.health(ANDROID_RESET_DEVICE, step)).rejects.toThrow(CTRL_PROXY_FAILED);
    expect(timer.now()).toBe(150_000);
    expect(calls).toBeGreaterThan(2);
  });
  test("clock root read timeout recovers and all adb budgets are derived", async () => {
    const { port, step, adb, timer } = nativeRig();
    timer.enableAutoAdvance();
    step.timeoutMs = 600_000;
    healthyClock(adb);
    const execute = adb.executeCommand.bind(adb);
    let reads = 0;
    adb.executeCommand = async (command, options) => {
      if (command === "shell id" && ++reads === 1) {
        throw new Error(SETTINGS_TIMEOUT);
      }
      return execute(command, options);
    };
    await port.health(ANDROID_RESET_DEVICE, step);
    expect(reads).toBe(2);
    expect(
      adb
        .getCommandCalls()
        .every(
          (call) =>
            call.timeoutMs === 18750 ||
            call.timeoutMs === 37484 ||
            call.timeoutMs === 30_000 ||
            call.timeoutMs === 74968,
        ),
    ).toBe(true);
  });
  test("non-timeout root failure fails immediately", async () => {
    const { port, step, adb, timer } = nativeRig();
    healthyClock(adb);
    adb.setCommandResult("shell id", "uid=2000(shell)");
    adb.setCommandResult("shell getprop ro.debuggable", "0");
    await expect(port.health(ANDROID_RESET_DEVICE, step)).rejects.toThrow();
    expect(timer.getSleepHistory()).toEqual([]);
    expect(adb.getCommandCalls().filter((call) => call.command === "shell id")).toHaveLength(1);
  });
});

describe("reset target resolution under load", () => {
  test("identity retries a timed-out real name resolver without retrying mismatched values", async () => {
    const { port, step, identityAdb, timer, changeAvd } = nativeRig();
    step.timeoutMs = 600_000;
    timer.enableAutoAdvance();
    const execute = identityAdb.executeCommand.bind(identityAdb);
    let probes = 0;
    identityAdb.executeCommand = async (command, options) => {
      if (++probes === 1) {
        timer.advanceTime(options?.timeoutMs ?? 0);
        throw new AdbCommandTimeoutError(SETTINGS_TIMEOUT);
      }
      return execute(command, options);
    };
    await expect(port.identity(ANDROID_RESET_DEVICE, step)).resolves.toMatchObject({
      avdName: ANDROID_RESET_DEVICE.name,
    });
    expect(probes).toBe(2);
    expect(timer.getSleepHistory()).toEqual([250]);
    changeAvd();
    await expect(port.identity(ANDROID_RESET_DEVICE, step)).rejects.toThrow("owned AVD");
    expect(probes).toBe(3);
  });
});
