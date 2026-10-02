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
import { RunnerReadinessError } from "../../src/utils/RunnerReadinessService";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeIOSCtrlProxyManager } from "../fakes/FakeIOSCtrlProxyManager";
import { FakeTimer } from "../fakes/FakeTimer";

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
  });

  function acquire(device: BootedDevice, signal?: AbortSignal) {
    deviceUtils.setBootedDevices(device.platform, [device]);
    const tool = ToolRegistry.getTool(device.platform === "android" ? "getAndroid" : "getApple")!;
    return tool.handler(
      {
        ...(device.platform === "android" ? { avdName: device.name } : { udid: device.deviceId }),
        bootTimeoutMs: 1_000,
        automationReadyTimeoutMs: 1_000,
      },
      undefined,
      signal,
    );
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
});
