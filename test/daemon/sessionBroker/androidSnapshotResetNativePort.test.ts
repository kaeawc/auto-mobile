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
import { drainUntil } from "../../helpers/fakeTimerStepping";
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
          options.signal,
          options.consoleExclusiveOwner,
        );
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
        timeoutMs: 5000,
        targetDeviceId: ANDROID_RESET_DEVICE.deviceId,
      });
      timer.advanceTime(1500);
      return [];
    };
    dependencies.emulator.getListedNonDeviceStatesAmong = async (_ids, options) => {
      expect(options?.timeoutMs).toBe(4500);
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
        ANDROID_RESET_DEVICE.deviceId,
        step.signal,
        { skipWakeAndUnlock: true },
      ],
    ]);
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
    const { port, step, adb, failHealth } = nativeRig();
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
