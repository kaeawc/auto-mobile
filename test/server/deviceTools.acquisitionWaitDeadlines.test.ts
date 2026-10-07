import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mutex } from "async-mutex";
import { ActionableError, type BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { AdbServerResetQuarantine } from "../../src/daemon/adbServerResetQuarantine";
import type { AndroidStartupLeaseRequest } from "../../src/daemon/devicePool";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceShutdownReservations } from "../../src/daemon/deviceShutdownReservations";
import { SessionManager } from "../../src/daemon/sessionManager";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { createStartDeviceHandlers } from "../../src/server/deviceToolsStartDevice";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { getAbortSignal, runWithAbortSignal } from "../../src/utils/AbortContext";
import { RunnerReadinessError } from "../../src/ctrlProxy/RunnerReadinessService";
import { RunnerReadinessService } from "../../src/ctrlProxy/RunnerReadinessService";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeIOSCtrlProxyManager } from "../fakes/FakeIOSCtrlProxyManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { ProgressExtendableDeadline } from "../../src/daemon/mcpRequestTimeout";
import {
  registerLiveDeadline,
  unregisterLiveDeadline,
} from "../../src/daemon/liveDeadlineRegistry";

isolateToolRegistry();

async function flushMicrotasks(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    await Promise.resolve();
  }
}

function observe(promise: Promise<unknown>) {
  const outcome: { settled: boolean; error?: unknown } = { settled: false };
  void promise.then(
    () => {
      outcome.settled = true;
    },
    (error: unknown) => {
      outcome.settled = true;
      outcome.error = error;
    },
  );
  return outcome;
}

describe("device acquisition wait deadlines", () => {
  let timer: FakeTimer;
  let deviceUtils: FakeDeviceUtils;
  let sessionManager: SessionManager;
  let pool: DevicePool;
  let mutex: Mutex;
  let reservations: DeviceShutdownReservations;
  let lifecycleReleases: number;
  let startupLeases: Map<symbol, AndroidStartupLeaseRequest>;
  const android: BootedDevice = { platform: "android", name: "Pixel", deviceId: "emulator-5554" };
  const ios: BootedDevice = { platform: "ios", name: "iPhone", deviceId: "sim-udid" };

  beforeEach(() => {
    timer = new FakeTimer();
    deviceUtils = new FakeDeviceUtils();
    lifecycleReleases = 0;
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        timer,
        deviceManager: deviceUtils,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        retryExecutor: new DefaultRetryExecutor(timer),
        adbServerResetQuarantineFactory: (port) => {
          startupLeases = port.getAndroidStartupLeases();
          return new AdbServerResetQuarantine(port);
        },
        deviceShutdownReservationsFactory: (port) => {
          mutex = port.getAssignmentMutex();
          reservations = new DeviceShutdownReservations(port);
          return reservations;
        },
      }),
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    setDeviceToolsDependencies({
      timer,
      deviceManagerFactory: () => deviceUtils,
      deviceMatcherFactory: () => new FakeDeviceMatcher(),
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
      ensureCtrlProxyReady: async () => {},
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      lifecycleCoordinator: {
        reserve: async (identity) => ({
          identity,
          signal: new AbortController().signal,
          bindCanonicalIdentity: async () => {},
          transitionToTeardown: () => {},
          release: () => {
            lifecycleReleases++;
          },
        }),
      },
    });
    registerDeviceTools();
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
    AndroidCtrlProxyManager.setExpectedChecksumForTesting(null);
  });

  function acquire(
    device: BootedDevice,
    signal?: AbortSignal,
    internalArgs: Record<string, unknown> = {},
  ) {
    deviceUtils.setBootedDevices(device.platform, [device]);
    const tool = ToolRegistry.getTool(device.platform === "android" ? "getAndroid" : "getApple")!;
    return tool.handler(
      {
        ...(device.platform === "android" ? { avdName: device.name } : { udid: device.deviceId }),
        bootTimeoutMs: 1_000,
        automationReadyTimeoutMs: 1_000,
        ...internalArgs,
      },
      undefined,
      signal,
    );
  }

  test("startDevice caps its boot/preparation budget by the anchored MCP deadline", async () => {
    let observedDeadline: number | undefined;
    const stopped = new Error("captured preparation before device work");
    const handlers = createStartDeviceHandlers({
      stripInternalAcquisitionParams: () => ({ platform: "android", name: "Pixel" }),
      prepareDevice: async (_args, budgets) => {
        observedDeadline = budgets.automationDeadlineMs;
        throw stopped;
      },
    });
    const rawArgs = { platform: "android" as const, name: "Pixel", __mcpRequestDeadlineMs: 500 };
    await expect(handlers.startDeviceHandler(rawArgs)).rejects.toBe(stopped);
    expect(observedDeadline).toBe(500);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  for (const mode of [
    "boot progress",
    "readiness progress",
    "no progress",
    "live without progress",
  ] as const) {
    const withProgress = mode === "boot progress" || mode === "readiness progress";
    test(`cold boot deadline: ${mode}`, async () => {
      const key = "cold-boot-deadline";
      const deadline = new ProgressExtendableDeadline(0, 180_000);
      if (mode !== "no progress") {
        registerLiveDeadline(key, deadline);
      }
      let acceptProgress = mode === "boot progress";
      deviceUtils.setDeviceImages("android", [
        { platform: "android", name: android.name, deviceId: android.deviceId, isRunning: false },
      ]);
      const bootGate = Promise.withResolvers<void>();
      const setupGate = Promise.withResolvers<void>();
      let setupSignal: AbortSignal | undefined;
      const ready = deviceUtils.waitForDeviceReady.bind(deviceUtils);
      deviceUtils.waitForDeviceReady = async (...args) => {
        await bootGate.promise;
        return await ready(...args);
      };
      const service = new RunnerReadinessService({
        timer,
        getAndroidManager: () => ({
          isInstalled: async () => true,
          isEnabled: async () => true,
          isVersionCompatible: async () => true,
          enable: async () => {},
          resetSetupState: () => {},
          setup: async () => ({ success: true, message: "ready" }),
          ensureCompatibleVersion: async () => {
            setupSignal = getAbortSignal();
            await setupGate.promise;
            setupSignal?.throwIfAborted();
            return { status: "compatible" };
          },
        }),
        getAndroidClient: () => ({
          isConnected: () => true,
          waitForConnection: async () => true,
          verifyServiceReady: async () => true,
          connectWithoutSetup: async () => true,
        }),
        getIosManager: () => {
          throw new Error("unexpected iOS manager");
        },
        getIosClient: () => {
          throw new Error("unexpected iOS client");
        },
        checkIosOverride: async () => ({ present: false, usable: true }),
        awaitIosStartupMaintenance: async () => {},
      });
      setDeviceToolsDependencies({
        ensureCtrlProxyReady: (request) => service.ensureReady(request),
      });
      const progress = withProgress
        ? async () => {
            if (acceptProgress) {
              deadline.extendOnProgress(timer.now(), 180_000);
            }
          }
        : undefined;
      const pending = ToolRegistry.getTool("getAndroid")!.handler(
        {
          avdName: android.name,
          __mcpRequestDeadlineMs: 180_000,
          ...(mode !== "no progress" ? { __mcpLiveDeadlineKey: key } : {}),
        },
        progress,
      );
      const outcome = observe(pending);
      try {
        await flushMicrotasks();
        timer.advanceTime(150_000);
        await progress?.();
        bootGate.resolve();
        await flushMicrotasks();
        expect(deviceUtils.wasMethodCalled("startDevice")).toBe(true);
        expect(setupSignal).toBeDefined();
        timer.advanceTime(29_000);
        if (mode === "readiness progress") {
          acceptProgress = true;
          await progress?.();
        }
        timer.advanceTime(1_000);
        await flushMicrotasks();
        if (withProgress) {
          expect(setupSignal?.aborted).toBe(false);
          timer.advanceTime(10_000);
          setupGate.resolve();
          await pending;
          expect(outcome.error).toBeUndefined();
          expect(sessionManager.getAllSessionIds()).toHaveLength(1);
        } else {
          expect(setupSignal?.aborted).toBe(true);
          setupGate.resolve();
          await expect(pending).rejects.toBeInstanceOf(ActionableError);
          expect(sessionManager.getAllSessionIds()).toEqual([]);
        }
        expect(timer.getSleepHistory()).toEqual([]);
        expect(lifecycleReleases).toBe(1);
        expect(timer.getPendingTimeoutCount()).toBe(0);
        deadline.extendOnProgress(timer.now(), 180_000);
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        bootGate.resolve();
        setupGate.resolve();
        unregisterLiveDeadline(key);
        await flushMicrotasks();
      }
    });
  }

  for (const stage of ["upgrade", "uninstall"] as const) {
    test(`cancelled APK ${stage} invalidates the installed cache`, async () => {
      const adb = new FakeAdbExecutor();
      const manager = AndroidCtrlProxyManager.createForTestingWithDeps(android, adb, timer);
      const listing = `shell pm list packages ${AndroidCtrlProxyManager.PACKAGE}`;
      adb.setCommandResponse(listing, {
        stdout: `package:${AndroidCtrlProxyManager.PACKAGE}`,
        stderr: "",
      });
      adb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
        stdout: "package:/data/app/ctrlproxy/base.apk",
        stderr: "",
      });
      // A known mismatched SHA selects upgrade; an unknown SHA selects reinstall.
      adb.setCommandResponse("shell sha256sum", {
        stdout: stage === "upgrade" ? "different-sha /data/app/ctrlproxy/base.apk" : "",
        stderr: "",
      });
      AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
      manager.downloadApk = async () => "fake.apk";
      manager.cleanupApk = async () => {};
      expect(await manager.isInstalled()).toBe(true);
      const execute = adb.executeCommand.bind(adb);
      const caller = new AbortController();
      let dispatched = false;
      adb.executeCommand = async (command, ...args) => {
        if (command.startsWith(stage === "upgrade" ? "install -r" : "shell pm uninstall")) {
          dispatched = true;
          // Model a package mutation completed on-device before cancellation arrived.
          adb.setCommandResponse(listing, { stdout: "", stderr: "" });
          caller.abort(new Error("caller cancelled"));
        }
        return await execute(command, ...args);
      };
      await expect(
        runWithAbortSignal(caller.signal, () =>
          manager.ensureCompatibleVersion({
            allowDownloadWhenInstalled: true,
          }),
        ),
      ).rejects.toThrow("cancelled");
      expect(dispatched).toBe(true);
      expect(await manager.isInstalled()).toBe(false);
      expect(timer.getSleepHistory()).toEqual([]);
    });
  }

  for (const stage of [
    "CtrlProxy APK install",
    "CtrlProxy APK upgrade",
    "CtrlProxy WebSocket connect",
    "CtrlProxy readiness wait",
    "iOS CtrlProxy setup",
  ]) {
    for (const mode of ["in-time", "deadline", "request abort"] as const) {
      const inTime = mode === "in-time";
      test(`${stage} acquisition ${mode}`, async () => {
        const platform = stage === "iOS CtrlProxy setup" ? "ios" : "android";
        const device = platform === "android" ? android : ios;
        await pool.addDevice(device);
        const adb = new FakeAdbExecutor();
        const manager = AndroidCtrlProxyManager.createForTestingWithDeps(android, adb, timer);
        let stageSignal: AbortSignal | undefined;
        const gate = Promise.withResolvers<void>();
        const execute = adb.executeCommand.bind(adb);
        const commands: string[] = [];
        adb.executeCommand = async (command, timeout, buffer, noRetry, signal) => {
          commands.push(command);
          if (!command.startsWith("install ")) {
            return execute(command, timeout, buffer, noRetry, signal);
          }
          stageSignal = signal ?? getAbortSignal();
          await gate.promise;
          return {
            stdout: "Success",
            stderr: "",
            toString: () => "Success",
            trim: () => "Success",
            includes: (value) => "Success".includes(value),
          };
        };
        AndroidCtrlProxyManager.setExpectedChecksumForTesting("expected-sha");
        adb.setCommandResponse(`shell pm list packages ${AndroidCtrlProxyManager.PACKAGE}`, {
          stdout: `package:${AndroidCtrlProxyManager.PACKAGE}`,
          stderr: "",
        });
        adb.setCommandResponse(`shell pm path ${AndroidCtrlProxyManager.PACKAGE}`, {
          stdout: "package:/data/app/ctrlproxy/base.apk",
          stderr: "",
        });
        adb.setCommandResponse("shell sha256sum", {
          stdout: "different-sha /data/app/ctrlproxy/base.apk",
          stderr: "",
        });
        manager.downloadApk = async () => "fake.apk";
        manager.cleanupApk = async () => {};
        let connectionReady = stage !== "CtrlProxy WebSocket connect" && platform === "android";
        const wait = async () => {
          stageSignal = getAbortSignal();
          await gate.promise;
          stageSignal?.throwIfAborted();
          connectionReady = true;
          return true;
        };
        const client = {
          isConnected: () => connectionReady,
          waitForConnection: stage === "CtrlProxy WebSocket connect" ? wait : async () => true,
          verifyServiceReady: stage === "CtrlProxy readiness wait" ? wait : async () => true,
          connectWithoutSetup: async () => true,
        };
        const service = new RunnerReadinessService({
          timer,
          getAndroidManager: () => ({
            isInstalled: async () => true,
            isEnabled: async () => true,
            isVersionCompatible: async () => true,
            enable: async () => {},
            resetSetupState: () => {},
            setup: async () => ({ success: true, message: "ready" }),
            ensureCompatibleVersion: async () => {
              if (stage === "CtrlProxy APK upgrade") {
                return manager.ensureCompatibleVersion({ allowDownloadWhenInstalled: true });
              }
              if (stage === "CtrlProxy APK install") {
                await manager.install("fake.apk");
              }
              return { status: "installed" };
            },
          }),
          getAndroidClient: () => client,
          getIosClient: () => client,
          getIosManager: () => ({
            isInstalled: async () => true,
            resetSetupState: () => {},
            getServicePort: () => 8765,
            start: async () => {},
            forceRestart: async () => {},
            setup: async (_force, _perf, signal) => {
              stageSignal = signal;
              await gate.promise;
              signal?.throwIfAborted();
              connectionReady = true;
              return { success: true, message: "ready" };
            },
          }),
          checkIosOverride: async () => ({ present: false, usable: true }),
          awaitIosStartupMaintenance: async () => {},
        });
        setDeviceToolsDependencies({
          ensureCtrlProxyReady: (request) => service.ensureReady(request),
        });
        const caller = new AbortController();
        if (mode === "request abort") {
          // Registered before the phase deadline to model the transport winning
          // the exact-deadline race. Its anchored deadline overrides the fallback.
          timer.setTimeout(
            () => caller.abort(new DOMException("MCP request timed out", "TimeoutError")),
            500,
          );
        }
        const pending = acquire(
          device,
          caller.signal,
          mode === "request abort"
            ? {
                __mcpRequestDeadlineMs: 500,
                __mcpRequestTimeoutMs: 9_000,
                __executionStartTime: 100,
              }
            : {
                __mcpRequestTimeoutMs: 500,
                __executionStartTime: 0,
              },
        );
        const outcome = observe(pending);
        try {
          await flushMicrotasks();
          expect(reservations.isReservedForReadiness(device.deviceId)).toBe(true);
          if (inTime) {
            timer.advanceTime(499);
            gate.resolve();
            await pending;
            expect(outcome.error).toBeUndefined();
            expect(stageSignal?.aborted).toBe(false);
            expect(sessionManager.getAllSessionIds()).toHaveLength(1);
          } else {
            timer.advanceTime(500);
            await flushMicrotasks();
            expect(stageSignal?.aborted).toBe(true);
            // An abort-ignoring dependency receives cancellation; bounded settlement
            // cannot strand the device when that dependency never resolves.
            timer.advanceTime(1_000);
            await flushMicrotasks();
            expect(outcome.settled).toBe(true);
            expect(outcome.error).toBeInstanceOf(ActionableError);
            expect((outcome.error as Error).message).toContain(stage);
            expect(sessionManager.getAllSessionIds()).toEqual([]);
          }
          expect(reservations.isReservedForReadiness(device.deviceId)).toBe(false);
          expect(lifecycleReleases).toBe(1);
          expect(timer.getSleepHistory()).toEqual([]);
        } finally {
          gate.resolve();
          await flushMicrotasks();
        }
        expect(sessionManager.getAllSessionIds()).toHaveLength(inTime ? 1 : 0);
        expect(commands.filter((command) => command.startsWith("install "))).toHaveLength(
          stage.startsWith("CtrlProxy APK") ? 1 : 0,
        );
        expect(commands.some((command) => command.startsWith("shell pm uninstall"))).toBe(false);
      });
    }
  }

  function ensureReady(device: BootedDevice, signal?: AbortSignal, totalDeadlineMs = 2_000) {
    const handlers = createStartDeviceHandlers({
      prepareDevice: async () => {
        throw new Error("unused preparation hook");
      },
      stripInternalAcquisitionParams: (args) => ({ ...args }),
    });
    return handlers.ensureCtrlProxyReady({
      device,
      requestedIdentity: "requested target",
      operationName: "provisionDevice",
      readinessTimeoutMs: 1_000,
      totalDeadlineMs,
      signal,
    });
  }

  for (const cancelled of [false, true]) {
    test(`getAndroid bounds a mutex-blocked readiness reservation on ${cancelled ? "abort" : "deadline"}`, async () => {
      await pool.addDevice(android);
      // Hold the actual pool assignment mutex only once the reservation call starts:
      // boot discovery must retain its normal fast path and ordering.
      const reserve = pool.reserveDeviceForReadiness.bind(pool);
      let unlock: (() => void) | undefined;
      let started = false;
      pool.reserveDeviceForReadiness = async (...args) => {
        unlock = await mutex.acquire();
        started = true;
        return await reserve(...args);
      };
      const controller = new AbortController();
      const reason = new ActionableError("caller cancelled acquisition");
      const outcome = observe(acquire(android, controller.signal));
      try {
        await flushMicrotasks();
        expect(started).toBe(true);
        timer.advanceTime(cancelled ? 500 : 1_999);
        await flushMicrotasks();
        expect(outcome.settled).toBe(false);
        if (cancelled) {
          controller.abort(reason);
        } else {
          timer.advanceTime(1);
        }
        await flushMicrotasks();
        expect(outcome.settled).toBe(false);
        timer.advanceTime(999);
        await flushMicrotasks();
        expect(outcome.settled).toBe(false);
        timer.advanceTime(1);
        await flushMicrotasks();
        expect(outcome.settled).toBe(true);
        if (cancelled) {
          expect(outcome.error).toBe(reason);
        } else {
          expect(outcome.error).toBeInstanceOf(ActionableError);
          expect((outcome.error as Error).message).toContain(
            "getAndroid timeout exhausted while reserving the device for readiness",
          );
          expect((outcome.error as Error).message).toContain("budgetMs=2000");
        }
        expect(lifecycleReleases).toBe(1);
      } finally {
        controller.abort(reason);
        unlock?.();
        await flushMicrotasks();
      }
      expect(reservations.isReservedForReadiness(android.deviceId)).toBe(false);
      expect(sessionManager.getAllSessionIds()).toEqual([]);
    });
  }

  for (const mode of ["boot deadline", "abort", "grant at boot deadline"]) {
    const cancelled = mode === "abort";
    const grantAtDeadline = mode === "grant at boot deadline";
    test(`getAndroid bounds a mutex-blocked startup lease on ${mode} and releases its late grant once`, async () => {
      await pool.addDevice(android);
      const reserve = pool.reserveAndroidStartupLease.bind(pool);
      let started = false;
      let grants = 0;
      let releases = 0;
      pool.reserveAndroidStartupLease = async (...args) => {
        started = true;
        const release = await reserve(...args);
        grants++;
        return async () => {
          releases++;
          await release();
        };
      };
      const unlock = await mutex.acquire();
      const controller = new AbortController();
      const reason = new DOMException("caller cancelled startup lease", "AbortError");
      const outcome = observe(acquire(android, controller.signal));
      try {
        await flushMicrotasks();
        expect(started).toBe(true);
        if (grantAtDeadline) {
          timer.setTimeout(unlock, 1_000);
        }
        timer.advanceTime(cancelled ? 500 : 999);
        await flushMicrotasks();
        expect(outcome.settled).toBe(false);
        if (cancelled) {
          controller.abort(reason);
        } else {
          timer.advanceTime(1);
        }
        await flushMicrotasks();
        expect(outcome.settled).toBe(true);
        if (cancelled) {
          expect(outcome.error).toBe(reason);
        } else {
          expect(outcome.error).toBeInstanceOf(ActionableError);
          expect((outcome.error as Error).message).toBe(
            "Timed out waiting for Android AVD reset recovery of 'Pixel'",
          );
        }
        expect(grants).toBe(grantAtDeadline ? 1 : 0);
        expect(lifecycleReleases).toBe(0);
      } finally {
        unlock();
        await flushMicrotasks();
      }
      expect(grants).toBe(1);
      expect(releases).toBe(1);
      expect(startupLeases.size).toBe(0);
      expect(reservations.isReservedForReadiness(android.deviceId)).toBe(false);
      expect(sessionManager.getAllSessionIds()).toEqual([]);
      expect(lifecycleReleases).toBe(0);
    });
  }

  test("getAndroid bounds failure finalization to the grace and drains each reservation once after the mutex frees", async () => {
    await pool.addDevice(android);
    let startupReleases = 0;
    const reserveStartup = pool.reserveAndroidStartupLease.bind(pool);
    pool.reserveAndroidStartupLease = async (...args) => {
      const release = await reserveStartup(...args);
      return async () => {
        startupReleases++;
        await release();
      };
    };
    let readinessReleases = 0;
    const reserveReadiness = pool.reserveDeviceForReadiness.bind(pool);
    pool.reserveDeviceForReadiness = async (...args) => {
      const release = await reserveReadiness(...args);
      return Object.assign(
        async () => {
          readinessReleases++;
          await release();
        },
        { owner: release.owner },
      );
    };
    let unlock: (() => void) | undefined;
    let started = false;
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        unlock = await mutex.acquire();
        started = true;
        timer.advanceTime(2_000);
        throw new ActionableError("getAndroid automation deadline exhausted");
      },
    });
    const outcome = observe(acquire(android));
    try {
      await flushMicrotasks();
      expect(started).toBe(true);
      // The injected runner failure models its deadline firing while finalization
      // is queued behind the real pool mutex; no new preparation may start.
      expect(readinessReleases).toBe(1);
      expect(reservations.isReservedForReadiness(android.deviceId)).toBe(true);
      expect(startupLeases.size).toBe(1);
      expect(lifecycleReleases).toBe(0);
      expect(outcome.settled).toBe(false);
      timer.advanceTime(999);
      await flushMicrotasks();
      expect(outcome.settled).toBe(false);
      timer.advanceTime(1);
      await flushMicrotasks();
      expect(outcome.settled).toBe(true);
      expect(outcome.error).toBeInstanceOf(ActionableError);
      expect((outcome.error as Error).message).toContain("automation deadline exhausted");
      expect(startupReleases).toBe(0);
      expect(lifecycleReleases).toBe(0);
    } finally {
      unlock?.();
      await flushMicrotasks();
    }
    expect(readinessReleases).toBe(1);
    expect(startupReleases).toBe(1);
    expect(lifecycleReleases).toBe(1);
    expect(startupLeases.size).toBe(0);
    expect(reservations.isReservedForReadiness(android.deviceId)).toBe(false);
    expect(sessionManager.getAllSessionIds()).toEqual([]);
  });

  test("getAndroid bounds partial lifecycle reservation rollback when startup release is mutex-blocked", async () => {
    await pool.addDevice(android);
    let unlock: (() => void) | undefined;
    let startupReleases = 0;
    const reserveStartup = pool.reserveAndroidStartupLease.bind(pool);
    pool.reserveAndroidStartupLease = async (...args) => {
      const release = await reserveStartup(...args);
      return async () => {
        startupReleases++;
        await release();
      };
    };
    const failure = new ActionableError("lifecycle deadline exhausted");
    setDeviceToolsDependencies({
      lifecycleCoordinator: {
        reserve: async () => {
          unlock = await mutex.acquire();
          timer.advanceTime(2_000);
          throw failure;
        },
      },
    });
    const outcome = observe(acquire(android));
    try {
      await flushMicrotasks();
      expect(startupLeases.size).toBe(1);
      expect(startupReleases).toBe(1);
      expect(outcome.settled).toBe(false);
      timer.advanceTime(999);
      await flushMicrotasks();
      expect(outcome.settled).toBe(false);
      timer.advanceTime(1);
      await flushMicrotasks();
      expect(outcome.settled).toBe(true);
      expect(outcome.error).toBeInstanceOf(ActionableError);
    } finally {
      unlock?.();
      await flushMicrotasks();
    }
    expect(startupReleases).toBe(1);
    expect(startupLeases.size).toBe(0);
    expect(lifecycleReleases).toBe(0);
    expect(reservations.isReservedForReadiness(android.deviceId)).toBe(false);
  });

  for (const grantAtDeadline of [false, true]) {
    test(`getAndroid releases an abort-ignoring readiness grant ${grantAtDeadline ? "at" : "after"} its deadline`, async () => {
      await pool.addDevice(android);
      const gate = Promise.withResolvers<void>();
      const reserve = pool.reserveDeviceForReadiness.bind(pool);
      let started = false;
      let grants = 0;
      let releases = 0;
      pool.reserveDeviceForReadiness = async (...args) => {
        started = true;
        await gate.promise;
        // Model the narrow late-grant case even if a pool implementation ignores
        // its ambient request cancellation after taking the assignment mutex.
        const reservation = await runWithAbortSignal(undefined, () => reserve(...args));
        grants++;
        return Object.assign(
          async () => {
            releases++;
            await reservation();
          },
          { owner: reservation.owner },
        );
      };
      const outcome = observe(acquire(android));
      try {
        await flushMicrotasks();
        expect(started).toBe(true);
        if (grantAtDeadline) {
          timer.setTimeout(() => gate.resolve(), 2_000);
        }
        timer.advanceTime(2_000);
        await flushMicrotasks();
        expect(outcome.settled).toBe(true);
        expect(outcome.error).toBeInstanceOf(ActionableError);
        expect((outcome.error as Error).message).toContain("reserving the device for readiness");
        expect(lifecycleReleases).toBe(1);
      } finally {
        gate.resolve();
        await flushMicrotasks();
      }
      expect(grants).toBe(1);
      expect(releases).toBe(1);
      expect(reservations.isReservedForReadiness(android.deviceId)).toBe(false);
      expect(sessionManager.getAllSessionIds()).toEqual([]);
    });
  }

  for (const cancelled of [false, true]) {
    test(`runner setup bounds a mutex-blocked shutdown check on ${cancelled ? "abort" : "deadline"}`, async () => {
      const unlock = await mutex.acquire();
      const controller = new AbortController();
      const reason = new DOMException("caller cancelled readiness", "AbortError");
      const outcome = observe(ensureReady(android, controller.signal));
      try {
        await flushMicrotasks();
        timer.advanceTime(cancelled ? 500 : 1_999);
        await flushMicrotasks();
        expect(outcome.settled).toBe(false);
        if (cancelled) {
          controller.abort(reason);
        } else {
          timer.advanceTime(1);
        }
        await flushMicrotasks();
        expect(outcome.settled).toBe(true);
        if (cancelled) {
          expect(outcome.error).toBe(reason);
        } else {
          expect(outcome.error).toBeInstanceOf(RunnerReadinessError);
          expect(outcome.error).toMatchObject({ deadlineExhausted: true, phase: "runner-setup" });
          expect((outcome.error as Error).message).toContain(
            "provisionDevice automation runner readiness failed: platform=android requested=[requested target] resolved=[Pixel (emulator-5554)] phase=runner-setup",
          );
        }
      } finally {
        controller.abort(reason);
        unlock();
        await flushMicrotasks();
      }
    });
  }

  for (const acquisition of [true, false]) {
    for (const cancelled of [false, true]) {
      test(`${acquisition ? "getApple" : "runner setup"} detaches shared iOS rearm on ${cancelled ? "abort" : "deadline"}`, async () => {
        const cleanup = Promise.withResolvers<void>();
        const fake = new FakeIOSCtrlProxyManager(timer);
        let started = false;
        let cleanupFinished = false;
        let cleanupSignal: AbortSignal | undefined;
        fake.rearmAfterDeviceReappearance = async () => {
          started = true;
          cleanupSignal = getAbortSignal();
          await cleanup.promise;
          cleanupFinished = true;
        };
        const manager = IOSCtrlProxyManager.createForTesting(ios, timer);
        manager.rearmAfterDeviceReappearance = fake.rearmAfterDeviceReappearance.bind(fake);
        const existing = spyOn(IOSCtrlProxyManager, "getExistingInstance").mockReturnValue(manager);
        const controller = new AbortController();
        const reason = new ActionableError("caller cancelled iOS wait");
        const outcome = observe(
          acquisition ? acquire(ios, controller.signal) : ensureReady(ios, controller.signal),
        );
        try {
          await flushMicrotasks();
          expect(started).toBe(true);
          timer.advanceTime(cancelled ? 500 : 1_999);
          await flushMicrotasks();
          expect(outcome.settled).toBe(false);
          if (cancelled) {
            controller.abort(reason);
          } else {
            timer.advanceTime(1);
          }
          await flushMicrotasks();
          expect(outcome.settled).toBe(true);
          if (cancelled) {
            expect(outcome.error).toBe(reason);
          } else if (acquisition) {
            expect(outcome.error).toBeInstanceOf(ActionableError);
            expect((outcome.error as Error).message).toContain(
              "getApple timeout exhausted while waiting for iOS runner removal cleanup",
            );
          } else {
            expect(outcome.error).toBeInstanceOf(RunnerReadinessError);
            expect(outcome.error).toMatchObject({ deadlineExhausted: true, phase: "runner-setup" });
          }
          expect(cleanupFinished).toBe(false);
          expect(cleanupSignal).toBeUndefined();
          if (acquisition) {
            expect(lifecycleReleases).toBe(1);
          }
        } finally {
          controller.abort(reason);
          cleanup.resolve();
          await flushMicrotasks();
          existing.mockRestore();
        }
        expect(cleanupFinished).toBe(true);
        expect(reservations.isReservedForReadiness(ios.deviceId)).toBe(false);
      });
    }
  }

  // #6034: a signal-ignoring readiness step must not hold the response past the
  // acquisition deadline, and a late success must neither bind a session nor
  // strand the device's reservations.
  for (const platform of ["android", "ios"] as const) {
    for (const deadlineKind of ["live", "anchored"] as const) {
      for (const mode of ["wedged", "in-time"] as const) {
        const operationName = platform === "android" ? "getAndroid" : "getApple";
        test(`${operationName} ${deadlineKind} deadline with ${mode} readiness`, async () => {
          const device = platform === "android" ? android : ios;
          await pool.addDevice(device);
          const readiness = Promise.withResolvers<void>();
          let readinessSignal: AbortSignal | undefined;
          setDeviceToolsDependencies({
            ensureCtrlProxyReady: async (request) => {
              readinessSignal = request.signal;
              // Deliberately ignores cancellation, modelling an unbounded inner await.
              await readiness.promise;
            },
          });
          const key = `wedged-readiness-${platform}-${deadlineKind}`;
          if (deadlineKind === "live") {
            registerLiveDeadline(key, new ProgressExtendableDeadline(0, 500));
          }
          const outcome = observe(
            acquire(device, undefined, {
              __mcpRequestDeadlineMs: 500,
              ...(deadlineKind === "live" ? { __mcpLiveDeadlineKey: key } : {}),
            }),
          );
          try {
            await flushMicrotasks();
            expect(readinessSignal).toBeDefined();
            expect(reservations.isReservedForReadiness(device.deviceId)).toBe(true);
            if (mode === "in-time") {
              timer.advanceTime(499);
              readiness.resolve();
              await flushMicrotasks();
              expect(outcome.settled).toBe(true);
              expect(outcome.error).toBeUndefined();
              expect(readinessSignal?.aborted).toBe(false);
              expect(sessionManager.getAllSessionIds()).toHaveLength(1);
              expect(timer.getPendingTimeoutCount()).toBe(0);
              return;
            }
            timer.advanceTime(500);
            await flushMicrotasks();
            // Inner structured errors keep precedence during the settlement grace.
            expect(outcome.settled).toBe(false);
            timer.advanceTime(3_000);
            await flushMicrotasks();
            expect(outcome.settled).toBe(true);
            expect(outcome.error).toBeInstanceOf(ActionableError);
            const message = (outcome.error as Error).message;
            expect(message).toContain(operationName);
            expect(message).toContain("preparing the automation runner");
            expect(readinessSignal?.aborted).toBe(true);
            expect(sessionManager.getAllSessionIds()).toEqual([]);
            // The wedged step still runs, so its reservations stay held.
            expect(reservations.isReservedForReadiness(device.deviceId)).toBe(true);
            expect(lifecycleReleases).toBe(0);
            expect(timer.getPendingTimeoutCount()).toBe(0);
            // A late inner success binds nothing and releases once settled.
            readiness.resolve();
            await flushMicrotasks();
            expect(sessionManager.getAllSessionIds()).toEqual([]);
            expect(reservations.isReservedForReadiness(device.deviceId)).toBe(false);
            expect(lifecycleReleases).toBe(1);
            expect(timer.getSleepHistory()).toEqual([]);
          } finally {
            readiness.resolve();
            unregisterLiveDeadline(key);
            await flushMicrotasks();
          }
        });
      }
    }
  }
});
