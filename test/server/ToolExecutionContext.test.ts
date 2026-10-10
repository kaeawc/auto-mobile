import { warmedTests } from "../helpers/warmedTests";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn } from "bun:test";
import { SessionManager, PLAN_AUTO_RELEASE_REASON } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  consumeSetupTiming,
  storeSetupTiming,
  createToolExecutionContext,
} from "../../src/server/ToolExecutionContext";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import {
  installNoOpReadinessDriver,
  setDeviceReadinessProxyDriverProviderForTesting,
} from "../helpers/stubCtrlProxySetup";
import { KeepScreenAwakeManager } from "../../src/utils/KeepScreenAwakeManager";
import { serverConfig } from "../../src/utils/ServerConfig";
import {
  acquireDeviceReadinessLock,
  deviceReadinessLockKey,
  trackDeviceAcquisitionReadiness,
} from "../../src/utils/deviceReadinessLock";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { getAbortSignal } from "../../src/utils/AbortContext";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import type { DeviceSession } from "../../src/db/types";
import type { ProxySetupResult } from "../../src/utils/interfaces/ProxyManager";
import { logger } from "../../src/utils/logger";

/** Drain pending microtasks without yielding to timers or I/O. */
const drainMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve();
  }
};

/**
 * Yield event-loop turns until `done` holds (or a fixed number of turns when
 * omitted). It never sleeps on a wall clock; it only lets already-queued
 * promise work and the fake timer's auto-advance tasks run.
 */
const drainTurns = async (done?: () => boolean): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) {
    if (done?.()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (done && !done()) {
    throw new Error("drainTurns: condition not reached");
  }
};

describe("ToolExecutionContext", () => {
  let sessionManager: SessionManager;
  let devicePool: DevicePool;
  let fakeAppsRepo: FakeInstalledAppsRepository;
  let fakeTimer: FakeTimer;
  let fakeDeviceManager: FakeDeviceManager;
  const originalGetInstance = AndroidCtrlProxyManager.getInstance;
  const originalClientGetInstance = AndroidCtrlProxyClient.getInstance;
  const sessionOptions = { keepScreenAwake: false };
  // The auto-advancing FakeTimer runs the readiness waits of a setup far past the default 2-minute
  // idle window; tests that race setups give their session a window those waits fit inside.
  const AUTO_ADVANCED_SETUP_IDLE_WINDOW_MS = 30 * 60_000;
  const createBootedDevice = (deviceId: string): BootedDevice => ({
    name: deviceId,
    platform: "android",
    deviceId,
  });

  const setup = async () => {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
    fakeAppsRepo = new FakeInstalledAppsRepository();
    fakeDeviceManager = new FakeDeviceManager();
    devicePool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
        timer: fakeTimer,
        installedAppsRepository: fakeAppsRepo,
        deviceManager: fakeDeviceManager,
      }),
    );
    // Discovery has to list the pooled device: an idle Android entry is
    // re-proved present before it is assigned, handsets included.
    fakeDeviceManager.bootedDevices = [createBootedDevice("device-1")];
    await devicePool.initializeWithDevices([createBootedDevice("device-1")]);

    // These tests exercise the real `ensureAccessibilityServiceReady` path and
    // stub setup via the `AndroidCtrlProxyManager`/`AndroidCtrlProxyClient`
    // `getInstance` statics per test. Restore the real readiness driver (which
    // routes through those statics) so the overrides take effect; the shared
    // preload's no-op driver (#6227) is re-installed in `afterEach` so the rest
    // of the process stays neutralized.
    setDeviceReadinessProxyDriverProviderForTesting(null);

    // Reset AndroidCtrlProxyClient instances for clean test state
    AndroidCtrlProxyClient.resetInstances();
  };

  function cleanup() {
    sessionManager?.stopCleanupTimer();
    AndroidCtrlProxyManager.getInstance = originalGetInstance;
    AndroidCtrlProxyClient.getInstance = originalClientGetInstance;
    AndroidCtrlProxyClient.resetInstances();
    installNoOpReadinessDriver();
  }

  const reset = async () => {
    cleanup();
    await setup();
  };
  const test = warmedTests(reset);

  test("setup timing belongs to each session on a shared device", async () => {
    await sessionManager.createSession("timing-a", "device-1", "android");
    await sessionManager.createSession("timing-b", "device-1", "android");
    const timingA = [{ name: "setup-a", durationMs: 5 }];
    const timingB = [{ name: "setup-b", durationMs: 7 }];
    const legacyTiming = [{ name: "legacy", durationMs: 3 }];
    storeSetupTiming("device-1", timingA, "timing-a", sessionManager);
    expect(consumeSetupTiming("device-1", "timing-b", sessionManager)).toBeNull();
    storeSetupTiming("device-1", timingB, "timing-b", sessionManager);
    storeSetupTiming("device-1", legacyTiming);
    expect(consumeSetupTiming("device-1", "timing-b", sessionManager)).toBe(timingB);
    expect(consumeSetupTiming("device-1", "timing-a", sessionManager)).toBe(timingA);
    expect(consumeSetupTiming("device-1", "timing-a", sessionManager)).toBeNull();
    expect(consumeSetupTiming("device-1")).toBe(legacyTiming);
    expect(consumeSetupTiming("device-1")).toBeNull();
  });

  test("setup timing falls back for direct mode and unassigned sessions", async () => {
    const directTiming = [{ name: "direct", durationMs: 2 }];
    storeSetupTiming("timing-direct-device", directTiming, "direct-session", undefined);
    expect(consumeSetupTiming("timing-direct-device", "direct-session", undefined)).toBe(
      directTiming,
    );
    expect(consumeSetupTiming("timing-direct-device", "direct-session", undefined)).toBeNull();

    await sessionManager.createSession("timing-unassigned", "another-device", "android");
    const unassignedTiming = [{ name: "unassigned", durationMs: 4 }];
    storeSetupTiming("device-1", unassignedTiming, "timing-unassigned", sessionManager);
    expect(consumeSetupTiming("device-1", "timing-unassigned", sessionManager)).toBe(
      unassignedTiming,
    );
    expect(consumeSetupTiming("device-1", "timing-unassigned", sessionManager)).toBeNull();
  });

  test("fallback setup timing is isolated and evicted oldest first at its cap", async () => {
    await sessionManager.createSession("timing-resolved", "device-1", "android");
    await sessionManager.createSession("timing-unassigned-owner", "another-device", "android");
    const fallbackTiming = [{ name: "fallback", durationMs: 1 }];
    storeSetupTiming("device-1", fallbackTiming, "timing-unassigned-owner", sessionManager);
    expect(consumeSetupTiming("device-1", "timing-resolved", sessionManager)).toBeNull();
    expect(consumeSetupTiming("device-1", "timing-unassigned-owner", sessionManager)).toBe(
      fallbackTiming,
    );

    const firstTiming = [{ name: "first", durationMs: 1 }];
    storeSetupTiming("timing-cap-0", firstTiming);
    for (let index = 1; index <= 256; index += 1) {
      storeSetupTiming(`timing-cap-${index}`, [{ name: "entry", durationMs: index }]);
    }
    expect(consumeSetupTiming("timing-cap-0")).toBeNull();
    expect(consumeSetupTiming("timing-cap-256")).not.toBeNull();
  });

  test("released sessions discard pending setup timing, including late writes", async () => {
    await sessionManager.createSession("timing-release", "device-1", "android");
    const timing = [{ name: "setup", durationMs: 5 }];
    storeSetupTiming("device-1", timing, "timing-release", sessionManager);
    await sessionManager.releaseSession("timing-release");
    expect(consumeSetupTiming("device-1", "timing-release", sessionManager)).toBeNull();
    storeSetupTiming("device-1", timing, "timing-release", sessionManager);
    await sessionManager.createSession("timing-new", "device-1", "android");
    expect(consumeSetupTiming("device-1", "timing-release", sessionManager)).toBeNull();
    expect(consumeSetupTiming("device-1", "timing-new", sessionManager)).toBeNull();
    expect(consumeSetupTiming("device-1")).toBeNull();
  });

  test("expired sessions discard pending setup timing", async () => {
    const session = await sessionManager.createSession("timing-expiry", "device-1", "android");
    storeSetupTiming(
      "device-1",
      [{ name: "setup", durationMs: 5 }],
      session.sessionId,
      sessionManager,
    );
    sessionManager.stopCleanupTimer();
    fakeTimer.advanceTime(session.expiresAt - fakeTimer.now() + 1);
    expect(consumeSetupTiming("device-1", session.sessionId, sessionManager)).toBeNull();
    await sessionManager.releaseSession(session.sessionId);
    await sessionManager.createSession("timing-after-expiry", "device-1", "android");
    expect(consumeSetupTiming("device-1", session.sessionId, sessionManager)).toBeNull();
    expect(consumeSetupTiming("device-1", "timing-after-expiry", sessionManager)).toBeNull();
    expect(consumeSetupTiming("device-1")).toBeNull();
  });

  beforeEach(reset);
  afterEach(cleanup);
  afterAll(cleanup);

  test("should run accessibility setup when creating a new session", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;

    const clientCallArgs: unknown[] = [];
    AndroidCtrlProxyClient.getInstance = ((device: unknown) => {
      clientCallArgs.push(device);
      return {
        waitForConnection: async () => true,
        resetConnectionBudget: () => {},
        close: async () => {},
      };
    }) as any;

    const context = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      sessionOptions,
    );

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
    expect(clientCallArgs.length).toBeGreaterThan(0);
    const passed = clientCallArgs[0] as BootedDevice;
    expect(typeof passed).toBe("object");
    expect(passed.deviceId).toBe("device-1");
    expect(passed.platform).toBe("android");
  });

  // Issue #7538: a successful setup() must reset the client's connection
  // budget/cooldown before ensureAccessibilityServiceReady calls
  // waitForConnection(), so failures recorded earlier in the session (#7537's
  // background reconnect, or an earlier failed readiness attempt) don't
  // silently gate the dial that would otherwise succeed.
  test("resets the connection budget after a successful setup, before waitForConnection", async () => {
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => ({ success: true, message: "ok" }),
      }) as any;

    const calls: string[] = [];
    AndroidCtrlProxyClient.getInstance = (() => ({
      resetConnectionBudget: () => {
        calls.push("resetConnectionBudget");
      },
      waitForConnection: async () => {
        calls.push("waitForConnection");
        return true;
      },
      close: async () => {},
    })) as any;

    const context = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      sessionOptions,
    );

    expect(context.deviceId).toBe("device-1");
    expect(calls).toEqual(["resetConnectionBudget", "waitForConnection"]);
  });

  // Issue #7541: a failed `waitForConnection()` used to throw straight out of
  // the retry loop, so the second of the two declared attempts was
  // unreachable and recovery only ever happened on a caller's NEXT call. It
  // is now a retryable failure handled INSIDE `ensureAccessibilityServiceReady`,
  // so a connection that comes up on the second attempt resolves within the
  // same `createToolExecutionContext` call — and the retry re-runs
  // `tryRebindUnhealthyAccessibilityService` + a fresh `setup()`, so the
  // second attempt is a real health-check-and-rebind rather than a bare
  // repeat of the first.
  test.each(["new", "persisted"])(
    "recovers a failed proxy connection within one call for a %s session (#7541)",
    async (entrypoint) => {
      let connected = false;
      let setupCalls = 0;
      let rebindCalls = 0;
      setDeviceReadinessProxyDriverProviderForTesting(() => ({
        resetSetupState: () => {},
        rebindIfUnhealthy: async () => {
          rebindCalls++;
          return false;
        },
        setup: async () => {
          setupCalls++;
          return { success: true, message: "ok" };
        },
        waitForConnection: async () => {
          const result = connected;
          // Recover on the retry the loop makes after this first failure.
          connected = true;
          return result;
        },
        isInstalled: async () => true,
        isVersionCompatible: async () => true,
      }));
      if (entrypoint === "persisted") {
        await sessionManager.createSession("connection-recovers", "device-1", "android");
        sessionManager.setDeviceReadiness("connection-recovers", "booted");
      }
      await createToolExecutionContext(
        "connection-recovers",
        sessionManager,
        devicePool,
        sessionOptions,
      );
      expect(sessionManager.getDeviceReadiness("connection-recovers")).toBe("automationReady");
      expect(setupCalls).toBe(2);
      expect(rebindCalls).toBe(2);
    },
  );

  // Issue #7541: the retry budget is bounded — a connection that never comes
  // up must still fail fast rather than retry forever, and must not record
  // `automationReady` for a device that was never actually reachable.
  test("throws after two consecutive failed connection attempts and does not record automationReady (#7541)", async () => {
    let setupCalls = 0;
    setDeviceReadinessProxyDriverProviderForTesting(() => ({
      resetSetupState: () => {},
      setup: async () => {
        setupCalls++;
        return { success: true, message: "ok" };
      },
      waitForConnection: async () => false,
      isInstalled: async () => true,
      isVersionCompatible: async () => true,
    }));
    await expect(
      createToolExecutionContext(
        "connection-never-recovers",
        sessionManager,
        devicePool,
        sessionOptions,
      ),
    ).rejects.toThrow("CtrlProxy connection");
    expect(sessionManager.getDeviceReadiness("connection-never-recovers")).not.toBe(
      "automationReady",
    );
    expect(setupCalls).toBe(2);
  });

  test("health-probes an upgraded session and restarts an unresponsive proxy once", async () => {
    const calls: string[] = [];
    setDeviceReadinessProxyDriverProviderForTesting(() => ({
      resetSetupState: () => {},
      rebindIfUnhealthy: async () => {
        calls.push("rebind");
        return false;
      },
      setup: async () => ({ success: true, message: "ok" }),
      waitForConnection: async () => {
        calls.push("connect");
        return true;
      },
      verifyServiceReady: async () => {
        calls.push("probe");
        return calls.filter((call) => call === "probe").length === 2;
      },
      forceRestartProcess: async () => {
        calls.push("restart");
        return true;
      },
      isInstalled: async () => true,
      isVersionCompatible: async () => true,
    }));
    await sessionManager.createSession("upgrade-health", "device-1", "android");
    sessionManager.setDeviceReadiness("upgrade-health", "booted");
    await createToolExecutionContext("upgrade-health", sessionManager, devicePool, sessionOptions);
    expect(sessionManager.getDeviceReadiness("upgrade-health")).toBe("automationReady");
    expect(calls).toEqual(["rebind", "connect", "probe", "restart", "probe"]);
  });

  test("an upgraded session accepts a driver without optional health primitives", async () => {
    const calls: string[] = [];
    setDeviceReadinessProxyDriverProviderForTesting(() => ({
      resetSetupState: () => {},
      setup: async () => {
        calls.push("setup");
        return { success: true, message: "ok" };
      },
      waitForConnection: async () => {
        calls.push("connect");
        return true;
      },
      isInstalled: async () => true,
      isVersionCompatible: async () => true,
    }));
    await sessionManager.createSession("upgrade-no-probe", "device-1", "android");
    sessionManager.setDeviceReadiness("upgrade-no-probe", "booted");
    await createToolExecutionContext(
      "upgrade-no-probe",
      sessionManager,
      devicePool,
      sessionOptions,
    );
    expect(sessionManager.getDeviceReadiness("upgrade-no-probe")).toBe("automationReady");
    expect(calls).toEqual(["setup", "connect"]);
  });

  // Issue #7541: retryability is classified by the typed `category` field
  // `AndroidCtrlProxyManager.setup` sets in its catch block, not by
  // substring-matching `message`/`error` a second time downstream. Device-
  // connection and timeout categories are transient and worth the loop's
  // bounded retry.
  test.each(["deviceConnection", "timeout"] as const)(
    "retries a %s-classified setup failure and resolves after two setup() calls (#7541)",
    async (category) => {
      let setupCalls = 0;
      setDeviceReadinessProxyDriverProviderForTesting(() => ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls++;
          if (setupCalls === 1) {
            return {
              success: false,
              message: "Failed to setup Accessibility Service",
              error: "error: device offline",
              category,
            };
          }
          return { success: true, message: "ok" };
        },
        waitForConnection: async () => true,
        isInstalled: async () => true,
        isVersionCompatible: async () => true,
      }));
      await createToolExecutionContext(
        `setup-retries-${category}`,
        sessionManager,
        devicePool,
        sessionOptions,
      );
      expect(sessionManager.getDeviceReadiness(`setup-retries-${category}`)).toBe(
        "automationReady",
      );
      expect(setupCalls).toBe(2);
    },
  );

  // Issue #7541: permission/install/unsupported/network failures are
  // terminal — retrying with the same inputs would fail identically — so
  // they must throw after exactly one `setup()` call instead of waiting out
  // the retry delay.
  test.each(["permission", "install"] as const)(
    "throws a %s-classified setup failure after exactly one setup() call (#7541)",
    async (category) => {
      let setupCalls = 0;
      setDeviceReadinessProxyDriverProviderForTesting(() => ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls++;
          return {
            success: false,
            message: "Failed to setup Accessibility Service",
            error: "permission denied",
            category,
          };
        },
        waitForConnection: async () => true,
        isInstalled: async () => true,
        isVersionCompatible: async () => true,
      }));
      await expect(
        createToolExecutionContext(
          `setup-terminal-${category}`,
          sessionManager,
          devicePool,
          sessionOptions,
        ),
      ).rejects.toThrow("Failed to setup accessibility service");
      expect(setupCalls).toBe(1);
    },
  );

  // Issue #7541: an abort during the retry delay must reject promptly with
  // the caller's own reason instead of waiting out the 3s sleep. That caller
  // was the flight's only waiter, so the flight ends abandoned instead of
  // retrying, and the follow-up call starts a fresh flight with its own setup.
  test("rejects promptly with the caller's reason when aborted during the retry sleep (#7541)", async () => {
    let setupCalls = 0;
    let resolveFirstSetup!: () => void;
    const firstSetupDone = new Promise<void>((resolve) => {
      resolveFirstSetup = resolve;
    });
    setDeviceReadinessProxyDriverProviderForTesting(() => ({
      resetSetupState: () => {},
      setup: async () => {
        setupCalls++;
        if (setupCalls === 1) {
          queueMicrotask(() => resolveFirstSetup());
          return {
            success: false,
            message: "Failed to setup Accessibility Service due to device connection issue",
            error: "error: device offline",
            category: "deviceConnection" as const,
          };
        }
        return { success: true, message: "ok" };
      },
      waitForConnection: async () => true,
      isInstalled: async () => true,
      isVersionCompatible: async () => true,
    }));
    await sessionManager.createSession("session-abort-retry-sleep", "device-1", "android");
    // The auto-advancing timer would otherwise jump to the idle sweep while the turns drain, and
    // an idle release is terminal (#11258): the follow-up call below must find the same session.
    sessionManager.stopCleanupTimer();
    const controller = new AbortController();
    const context = createToolExecutionContext(
      "session-abort-retry-sleep",
      sessionManager,
      devicePool,
      sessionOptions,
      undefined,
      undefined,
      false,
      controller.signal,
    );
    // The fake timer's auto-advance fires the retry sleep only once the microtask
    // queue goes quiet, so waiting for the microtask-scheduled `firstSetupDone`
    // here is guaranteed to land before the retry sleep's fake deadline fires.
    await firstSetupDone;
    controller.abort(new Error("caller cancelled during retry sleep"));
    await expect(context).rejects.toThrow("caller cancelled during retry sleep");
    // Give auto-advance the turns it would need to fire the 3s retry sleep:
    // a flight that kept retrying would call setup() a second time here.
    await drainTurns();
    expect(setupCalls).toBe(1);
    expect(sessionManager.getDeviceReadiness("session-abort-retry-sleep")).toBeUndefined();
    await createToolExecutionContext(
      "session-abort-retry-sleep",
      sessionManager,
      devicePool,
      sessionOptions,
    );
    expect(setupCalls).toBe(2);
    expect(sessionManager.getDeviceReadiness("session-abort-retry-sleep")).toBe("automationReady");
  });

  describe("readiness flight with no waiters left (#7541 follow-up)", () => {
    const RETRY_DELAY_MS = 3000;
    const transientFailure: ProxySetupResult = {
      success: false,
      message: "Failed to setup Accessibility Service due to device connection issue",
      error: "error: device offline",
      category: "deviceConnection",
    };
    let manualTimer: FakeTimer;
    let manualSessionManager: SessionManager;
    let manualPool: DevicePool;

    /** Each setup() call parks until the test settles it. */
    const gatedSetup = () => {
      const started = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
      const results = Array.from({ length: 4 }, () => Promise.withResolvers<ProxySetupResult>());
      let calls = 0;
      setDeviceReadinessProxyDriverProviderForTesting(() => ({
        resetSetupState: () => {},
        setup: async () => {
          const index = calls++;
          started[index].resolve();
          return results[index].promise;
        },
        waitForConnection: async () => true,
        isInstalled: async () => true,
        isVersionCompatible: async () => true,
      }));
      return { started, results, calls: () => calls };
    };

    const startContext = (sessionId: string, signal?: AbortSignal) =>
      createToolExecutionContext(
        sessionId,
        manualSessionManager,
        manualPool,
        sessionOptions,
        undefined,
        undefined,
        false,
        signal,
      );

    const abandonedLogs = (debugSpy: { mock: { calls: unknown[][] } }) =>
      debugSpy.mock.calls.filter((call) =>
        String(call[0]).includes("Readiness flight abandoned: no waiters"),
      );

    const setupManual = async () => {
      // Manual stepping only: time moves when a test calls advanceTimeAsync.
      manualTimer = new FakeTimer();
      manualSessionManager = new SessionManager(manualTimer, new FakeDeviceSessionPersistence());
      const manualDeviceManager = new FakeDeviceManager();
      manualDeviceManager.bootedDevices = [createBootedDevice("device-1")];
      manualPool = new DevicePool(
        createDevicePoolDependencies(manualSessionManager, "test-daemon-session-id", {
          timer: manualTimer,
          installedAppsRepository: new FakeInstalledAppsRepository(),
          deviceManager: manualDeviceManager,
        }),
      );
      await manualPool.initializeWithDevices([createBootedDevice("device-1")]);
    };

    afterEach(() => {
      manualSessionManager?.stopCleanupTimer();
    });

    test("the last waiter leaving during the retry sleep ends the flight without a second setup()", async () => {
      await setupManual();
      const debugSpy = spyOn(logger, "debug");
      try {
        const gate = gatedSetup();
        await manualSessionManager.createSession("no-waiters-sleep", "device-1", "android");
        const controller = new AbortController();
        const context = startContext("no-waiters-sleep", controller.signal);
        await gate.started[0].promise;
        gate.results[0].resolve(transientFailure);
        await drainTurns(() => manualTimer.getPendingTimeouts().includes(RETRY_DELAY_MS));

        controller.abort(new Error("last waiter left"));
        await expect(context).rejects.toThrow("last waiter left");
        await drainTurns(() => abandonedLogs(debugSpy).length > 0);

        // The retry sleep ended early and released its timer.
        expect(manualTimer.getPendingTimeouts()).not.toContain(RETRY_DELAY_MS);
        await manualTimer.advanceTimeAsync(RETRY_DELAY_MS, drainMicrotasks);
        expect(gate.calls()).toBe(1);
        expect(abandonedLogs(debugSpy)).toHaveLength(1);
        expect(String(abandonedLogs(debugSpy)[0][0])).toContain(
          "deviceId=device-1, attemptsCompleted=1",
        );
        expect(manualSessionManager.getDeviceReadiness("no-waiters-sleep")).toBeUndefined();
      } finally {
        debugSpy.mockRestore();
      }
    });

    test("one of two waiters leaving keeps the flight retrying for the other", async () => {
      await setupManual();
      const gate = gatedSetup();
      await manualSessionManager.createSession("one-waiter-left", "device-1", "android");
      const leaving = new AbortController();
      const staying = new AbortController();
      const leavingContext = startContext("one-waiter-left", leaving.signal);
      await gate.started[0].promise;
      gate.results[0].resolve(transientFailure);
      await drainTurns(() => manualTimer.getPendingTimeouts().includes(RETRY_DELAY_MS));
      const stayingContext = startContext("one-waiter-left", staying.signal);
      await drainTurns();

      leaving.abort(new Error("first waiter left"));
      await expect(leavingContext).rejects.toThrow("first waiter left");
      await drainTurns();
      // The remaining waiter keeps the flight's retry sleep alive.
      expect(manualTimer.getPendingTimeouts()).toContain(RETRY_DELAY_MS);
      expect(gate.calls()).toBe(1);

      await manualTimer.advanceTimeAsync(RETRY_DELAY_MS, drainMicrotasks);
      await gate.started[1].promise;
      gate.results[1].resolve({ success: true, message: "ok" });
      await stayingContext;
      expect(gate.calls()).toBe(2);
      expect(manualSessionManager.getDeviceReadiness("one-waiter-left")).toBe("automationReady");
    });

    test("an abort during setup() lets that setup finish, then starts no further attempt", async () => {
      await setupManual();
      const debugSpy = spyOn(logger, "debug");
      try {
        const gate = gatedSetup();
        await manualSessionManager.createSession("no-waiters-mid-setup", "device-1", "android");
        const controller = new AbortController();
        const context = startContext("no-waiters-mid-setup", controller.signal);
        await gate.started[0].promise;

        controller.abort(new Error("left mid-setup"));
        await expect(context).rejects.toThrow("left mid-setup");
        expect(abandonedLogs(debugSpy)).toHaveLength(0);

        // The in-progress setup() still runs to completion.
        gate.results[0].resolve(transientFailure);
        await drainTurns(() => abandonedLogs(debugSpy).length > 0);
        expect(manualTimer.getPendingTimeouts()).not.toContain(RETRY_DELAY_MS);
        await manualTimer.advanceTimeAsync(RETRY_DELAY_MS, drainMicrotasks);
        expect(gate.calls()).toBe(1);
        expect(abandonedLogs(debugSpy)).toHaveLength(1);
        expect(manualSessionManager.getDeviceReadiness("no-waiters-mid-setup")).toBeUndefined();
      } finally {
        debugSpy.mockRestore();
      }
    });

    test("a caller arriving after an abandoned flight starts a fresh flight", async () => {
      await setupManual();
      const debugSpy = spyOn(logger, "debug");
      try {
        const gate = gatedSetup();
        await manualSessionManager.createSession("fresh-after-abandon", "device-1", "android");
        const controller = new AbortController();
        const context = startContext("fresh-after-abandon", controller.signal);
        await gate.started[0].promise;
        gate.results[0].resolve(transientFailure);
        await drainTurns(() => manualTimer.getPendingTimeouts().includes(RETRY_DELAY_MS));
        controller.abort(new Error("left during sleep"));
        await expect(context).rejects.toThrow("left during sleep");
        await drainTurns(() => abandonedLogs(debugSpy).length > 0);
        expect(gate.calls()).toBe(1);

        // No time advance: the fresh flight's setup() runs immediately rather
        // than after the abandoned flight's retry delay.
        const fresh = startContext("fresh-after-abandon");
        await gate.started[1].promise;
        expect(gate.calls()).toBe(2);
        gate.results[1].resolve({ success: true, message: "ok" });
        await fresh;
        expect(gate.calls()).toBe(2);
        expect(manualSessionManager.getDeviceReadiness("fresh-after-abandon")).toBe(
          "automationReady",
        );
      } finally {
        debugSpy.mockRestore();
      }
    });
  });

  test("preserves the caller's abort reason while shared setup completes", async () => {
    const setupStarted = Promise.withResolvers<void>();
    const finishSetup = Promise.withResolvers<void>();
    let setupCalls = 0;
    setDeviceReadinessProxyDriverProviderForTesting(() => ({
      resetSetupState: () => {},
      setup: async () => {
        setupCalls++;
        setupStarted.resolve();
        await finishSetup.promise;
        return { success: true, message: "ok" };
      },
      waitForConnection: async () => true,
      isInstalled: async () => true,
      isVersionCompatible: async () => true,
    }));
    await sessionManager.createSession("session-abort-during-setup", "device-1", "android");
    const controller = new AbortController();
    const reason = new Error("caller cancelled during setup");
    const context = createToolExecutionContext(
      "session-abort-during-setup",
      sessionManager,
      devicePool,
      sessionOptions,
      undefined,
      undefined,
      false,
      controller.signal,
    );
    await setupStarted.promise;
    controller.abort(reason);
    finishSetup.resolve();
    await expect(context).rejects.toBe(reason);
    expect(setupCalls).toBe(1);
  });

  test("does not run accessibility setup when a pooled emulator serial is stale", async () => {
    const staleDeviceManager = new FakeDeviceManager();
    const stalePool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
        timer: fakeTimer,
        installedAppsRepository: fakeAppsRepo,
        deviceManager: staleDeviceManager,
        retryExecutor: new DefaultRetryExecutor(fakeTimer),
      }),
    );
    await stalePool.initializeWithDevices([createBootedDevice("emulator-5554")]);
    staleDeviceManager.bootedDevices = [];

    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;

    await expect(
      createToolExecutionContext("session-stale", sessionManager, stalePool, sessionOptions),
    ).rejects.toThrow(/No devices in pool|not available|disconnected/);
    expect(setupCalls).toBe(0);
    expect(stalePool.getDevice("emulator-5554")).toBeNull();
  });

  test("writes the keep-awake state to the typed keepScreenAwake slot on setup (#2973)", async () => {
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => ({ success: true, message: "ok" }),
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    // keepScreenAwake:false → apply() short-circuits to an applied:false state,
    // which ensureKeepScreenAwake must persist to the typed slot (not customData).
    await createToolExecutionContext("session-1", sessionManager, devicePool, sessionOptions);

    const state = sessionManager.getKeepScreenAwake("session-1");
    expect(state).toBeDefined();
    expect(state!.applied).toBe(false);
    expect(
      (sessionManager.getSessionCache("session-1") as Record<string, unknown>).customData,
    ).toBeUndefined();
  });

  // #6227: the persisted daemon-session path (ToolRegistry passing sessionUuid
  // into createToolExecutionContext) must honor a tool's declared
  // deviceReadiness the same way the legacy/no-session path already does via
  // DeviceSessionManager.ensureDeviceReady's `readiness` option.
  test("skips accessibility setup for a new session when deviceReadiness is booted (#6227)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;

    const context = await createToolExecutionContext("session-1", sessionManager, devicePool, {
      ...sessionOptions,
      deviceReadiness: "booted",
    });

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(0);
  });

  test("checks unhealthy binding before setup on an existing session", async () => {
    const calls: string[] = [];
    setDeviceReadinessProxyDriverProviderForTesting(() => ({
      resetSetupState: () => calls.push("reset"),
      rebindIfUnhealthy: async () => {
        calls.push("rebind");
        return true;
      },
      setup: async () => {
        calls.push("setup");
        return { success: true, message: "ok" };
      },
      waitForConnection: async () => {
        calls.push("wait");
        return true;
      },
      isInstalled: async () => true,
      isVersionCompatible: async () => true,
    }));
    await sessionManager.createSession("unbound-service", "device-1", "android");
    sessionManager.setDeviceReadiness("unbound-service", "booted");

    await createToolExecutionContext("unbound-service", sessionManager, devicePool, sessionOptions);

    expect(calls).toEqual(["reset", "rebind", "setup", "wait"]);
    expect(sessionManager.getDeviceReadiness("unbound-service")).toBe("automationReady");
  });

  test("continues setup when the optional binding check fails", async () => {
    const calls: string[] = [];
    setDeviceReadinessProxyDriverProviderForTesting(() => ({
      resetSetupState: () => {},
      rebindIfUnhealthy: async () => {
        calls.push("rebind");
        throw new Error("binding probe failed");
      },
      setup: async () => {
        calls.push("setup");
        return { success: true, message: "ok" };
      },
      waitForConnection: async () => {
        calls.push("wait");
        return true;
      },
      isInstalled: async () => true,
      isVersionCompatible: async () => true,
    }));
    await sessionManager.createSession("binding-probe", "device-1", "android");
    sessionManager.setDeviceReadiness("binding-probe", "booted");

    await createToolExecutionContext("binding-probe", sessionManager, devicePool, sessionOptions);

    expect(calls).toEqual(["rebind", "setup", "wait"]);
    expect(sessionManager.getDeviceReadiness("binding-probe")).toBe("automationReady");
  });

  test("still runs accessibility setup for a new session when deviceReadiness is automationReady (#6227)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    const context = await createToolExecutionContext("session-1", sessionManager, devicePool, {
      ...sessionOptions,
      deviceReadiness: "automationReady",
    });

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
  });

  test("a tool not requiring readiness (deviceReadiness omitted) is unaffected on the persisted path (#6227)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    // No deviceReadiness set — behaves exactly as before this fix (default
    // automationReady semantics), for both a new session...
    const freshContext = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      sessionOptions,
    );
    expect(freshContext.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);

    // ...and an already-established session (existingSession short-circuit,
    // unrelated to deviceReadiness).
    const existingContext = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      sessionOptions,
    );
    expect(existingContext.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
  });

  // #6227 P1 (round 5): a NORMAL freshly-acquired session (getAndroid /
  // startDevice) already ran `prepareStartDeviceRunnerReadiness` — CtrlProxy /
  // accessibility-service setup genuinely completed — before the session was
  // bound. The acquisition/binding path now records that achieved level via
  // `setDeviceReadiness` at bind time (mirroring what `bindBootedDeviceSession`
  // in deviceTools.ts does), so the first subsequent `automationReady` tool
  // call must NOT see `undefined` and redundantly re-run setup.
  test("does not redundantly re-run setup for a session whose readiness was recorded at acquisition (#6227 round 5 P1)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    // Simulate the acquisition/binding path: the session is created and its
    // achieved readiness is recorded (as `bindBootedDeviceSession` now does)
    // BEFORE any tool call reaches `createToolExecutionContext`.
    await sessionManager.createSession("session-acquired", "device-1", "android");
    sessionManager.setDeviceReadiness("session-acquired", "automationReady");

    const context = await createToolExecutionContext(
      "session-acquired",
      sessionManager,
      devicePool,
      {
        ...sessionOptions,
        deviceReadiness: "automationReady",
      },
    );

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(0);
    await createToolExecutionContext("session-acquired", sessionManager, devicePool, {
      ...sessionOptions,
      deviceReadiness: "automationReady",
    });
    expect(setupCalls).toBe(0);
  });

  test("reruns setup after automation readiness is invalidated for a session", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    await sessionManager.createSession("lost-service", "device-1", "android");
    sessionManager.setDeviceReadiness("lost-service", "automationReady");
    sessionManager.invalidateAutomationReadiness("lost-service", "test");

    await createToolExecutionContext("lost-service", sessionManager, devicePool, sessionOptions);

    expect(setupCalls).toBe(1);
    expect(sessionManager.getDeviceReadiness("lost-service")).toBe("automationReady");
  });

  // Companion case: a session recovered without its readiness genuinely
  // re-established (e.g. mid-recovery, unrecorded) must still be treated as
  // not-ready and run setup — the acquisition-time recording above must not
  // widen the concurrency-hole fix in `isReadinessSatisfied`.
  test("still runs setup for a genuinely-unrecorded recovered session (#6227 round 5 P1)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    // No `setDeviceReadiness` call here — this session's readiness was never
    // recorded, mirroring a recovered session whose acquisition never
    // completed `prepareStartDeviceRunnerReadiness` cleanly.
    await sessionManager.createSession("session-unrecorded-recovery", "device-1", "android");

    const context = await createToolExecutionContext(
      "session-unrecorded-recovery",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
    );

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
  });

  // #6227 P1 follow-up: a session first reached via a `booted` tool must be
  // *upgraded* — not left disconnected — when a later call on the same
  // sessionUuid needs `automationReady`. The `existingSession` fast path must
  // not silently satisfy a stricter readiness requirement than the session
  // actually achieved.
  test("upgrades a booted-only session to automationReady when a later call needs it (#6227)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    const bootedContext = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      {
        ...sessionOptions,
        deviceReadiness: "booted",
      },
    );
    expect(bootedContext.deviceId).toBe("device-1");
    expect(setupCalls).toBe(0);
    expect(sessionManager.getDeviceReadiness("session-1")).toBe("booted");

    // Same sessionUuid, now via an automationReady tool — must run setup
    // (upgrade), not take the existingSession skip path.
    const upgradedContext = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      {
        ...sessionOptions,
        deviceReadiness: "automationReady",
      },
    );
    expect(upgradedContext.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
    expect(sessionManager.getDeviceReadiness("session-1")).toBe("automationReady");
  });

  test("reruns automation readiness after a VM restore resets the session marker", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    await createToolExecutionContext("restore-session", sessionManager, devicePool, sessionOptions);
    sessionManager.resetDeviceReadinessForDevice("device-1");
    await createToolExecutionContext("restore-session", sessionManager, devicePool, sessionOptions);

    expect(setupCalls).toBe(2);
  });

  test("does not redundantly re-run setup for a booted tool after an automationReady session (#6227)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    const readyContext = await createToolExecutionContext("session-1", sessionManager, devicePool, {
      ...sessionOptions,
      deviceReadiness: "automationReady",
    });
    expect(readyContext.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);

    // Same sessionUuid, now via a booted-only tool — must NOT downgrade or
    // redundantly redo setup.
    const bootedContext = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      {
        ...sessionOptions,
        deviceReadiness: "booted",
      },
    );
    expect(bootedContext.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
    expect(sessionManager.getDeviceReadiness("session-1")).toBe("automationReady");
  });

  // #6227 P1 follow-up: a concurrency window where a `booted` request
  // publishes the recovered session into `SessionManager`'s in-memory map
  // (`this.sessions.set(...)`) and then pauses in `ensureKeepScreenAwake`
  // *before* recording its readiness. A concurrent `automationReady` request
  // that resolves the same sessionUuid in that window must NOT treat the
  // still-undefined recorded readiness as satisfied and skip setup.
  test("runs setup for a concurrent automationReady call that observes a published-but-unrecorded session (#6227)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    // Simulate the race directly: a session already published into the
    // SessionManager's in-memory map (as `createSession` does), but with its
    // deviceReadiness NOT YET recorded — exactly the state a concurrent
    // `booted` request's session is in after publish but before
    // `runDeviceReadinessSetup` records the level.
    await sessionManager.createSession("session-race-window", "device-1", "android");
    expect(sessionManager.getDeviceReadiness("session-race-window")).toBeUndefined();

    // A concurrent automationReady request resolves this same session as
    // "existing" and must run setup rather than trusting the unrecorded
    // readiness.
    const context = await createToolExecutionContext(
      "session-race-window",
      sessionManager,
      devicePool,
      {
        ...sessionOptions,
        deviceReadiness: "automationReady",
      },
    );

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
    expect(sessionManager.getDeviceReadiness("session-race-window")).toBe("automationReady");
  });

  // #6227 P1 review follow-up: two `automationReady` calls that reach a
  // freshly-published session (readiness still undefined) *concurrently* must
  // NOT both run `runDeviceReadinessSetup` — the second observing the first
  // mid-setup would call `resetSetupState()` on the shared per-device
  // CtrlProxy manager while the first's `setup()` is still in flight. Setup
  // must run exactly once (single-flight), and both callers must observe the
  // upgraded readiness once it resolves.
  test("serializes concurrent automationReady upgrades on the same session so setup runs exactly once (#6227)", async () => {
    let setupCalls = 0;
    let resetCalls = 0;
    let releaseSetup!: () => void;
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let setupEnteredResolve!: () => void;
    const setupEntered = new Promise<void>((resolve) => {
      setupEnteredResolve = resolve;
    });

    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {
          resetCalls += 1;
        },
        setup: async () => {
          setupCalls += 1;
          setupEnteredResolve();
          await setupGate;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    // Publish the session with readiness NOT YET recorded — the same window
    // a recovered/newly-published session sits in before this module's own
    // setup pass records a level.
    await sessionManager.createSession("session-race-concurrent", "device-1", "android");
    expect(sessionManager.getDeviceReadiness("session-race-concurrent")).toBeUndefined();

    const call1 = createToolExecutionContext(
      "session-race-concurrent",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
    );

    // Let call1 run until it has actually entered `setup()` (i.e. it has
    // already registered itself as the in-flight upgrade for this session)
    // before starting the second, concurrent caller.
    await setupEntered;

    const call2 = createToolExecutionContext(
      "session-race-concurrent",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
    );

    // Give call2 a chance to observe the in-flight upgrade and start
    // awaiting it, then let the single in-flight setup complete.
    await Promise.resolve();
    await Promise.resolve();
    releaseSetup();

    const [context1, context2] = await Promise.all([call1, call2]);

    expect(context1.deviceId).toBe("device-1");
    expect(context2.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
    expect(resetCalls).toBe(1);
    expect(sessionManager.getDeviceReadiness("session-race-concurrent")).toBe("automationReady");
  });

  test("serializes concurrent setup after automation readiness is invalidated", async () => {
    let setupCalls = 0;
    const setupEntered = Promise.withResolvers<void>();
    const setupGate = Promise.withResolvers<void>();
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          setupEntered.resolve();
          await setupGate.promise;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    await sessionManager.createSession("lost-service-concurrent", "device-1", "android");
    sessionManager.setDeviceReadiness("lost-service-concurrent", "automationReady");
    sessionManager.invalidateAutomationReadiness("lost-service-concurrent", "test");

    const call1 = createToolExecutionContext(
      "lost-service-concurrent",
      sessionManager,
      devicePool,
      sessionOptions,
    );
    await setupEntered.promise;
    const call2 = createToolExecutionContext(
      "lost-service-concurrent",
      sessionManager,
      devicePool,
      sessionOptions,
    );
    await Promise.resolve();
    await Promise.resolve();
    setupGate.resolve();

    const [context1, context2] = await Promise.all([call1, call2]);
    expect(context1.deviceId).toBe("device-1");
    expect(context2.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
    expect(sessionManager.getDeviceReadiness("lost-service-concurrent")).toBe("automationReady");
  });

  // #6227 P1 follow-up (round 3): the round-2 single-flight above only
  // serialized the *existing-session upgrade* path. A brand-new sessionUuid
  // that two callers race for concurrently hits a second, unguarded hole:
  // `getSessionForNewExecution` returns `null` (existingSession) for BOTH
  // callers before either's `getOrCreateSession` call has published the
  // session, so both `setupSession` invocations take the *fresh-session*
  // branch (`existingSession === session` is false for both) — and, before
  // this fix, that branch called `runDeviceReadinessSetup` directly,
  // unguarded by `readinessUpgradeInFlight`. Both callers join the same
  // `pendingSessionAssignments` entry (so they resolve to the identical
  // `Session` object), then both would concurrently call
  // `resetSetupState()`/`setup()` on the shared per-device CtrlProxy manager.
  // Routing the fresh-session branch through `ensureReadinessUpgraded` too
  // (same map, keyed by `session.sessionId`) closes this: setup must run
  // exactly once even when both concurrent callers take the fresh path.
  test("routes concurrent fresh-session setups for the same new sessionUuid through the single-flight so setup runs exactly once (#6227)", async () => {
    let setupCalls = 0;
    let resetCalls = 0;
    let releaseSetup!: () => void;
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let setupEnteredResolve!: () => void;
    const setupEntered = new Promise<void>((resolve) => {
      setupEnteredResolve = resolve;
    });

    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {
          resetCalls += 1;
        },
        setup: async () => {
          setupCalls += 1;
          setupEnteredResolve();
          await setupGate;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    // Neither call awaits before the other starts: both synchronously
    // observe `getSessionForNewExecution` returning `null` for this
    // never-before-seen sessionUuid, then join the same
    // `pendingSessionAssignments` entry once the second call reaches it —
    // exactly the race described above.
    const call1 = createToolExecutionContext(
      "session-race-fresh-both",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
    );
    const call2 = createToolExecutionContext(
      "session-race-fresh-both",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
    );

    // Let the single in-flight setup actually enter `setup()` before
    // releasing it, then give any second (would-be) caller a chance to
    // observe the in-flight upgrade before it completes.
    await setupEntered;
    await Promise.resolve();
    await Promise.resolve();
    releaseSetup();

    const [context1, context2] = await Promise.all([call1, call2]);

    expect(context1.deviceId).toBe("device-1");
    expect(context2.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
    expect(resetCalls).toBe(1);
    expect(sessionManager.getDeviceReadiness("session-race-fresh-both")).toBe("automationReady");
  });

  // #6227 P1 follow-up (round 4): a `booted`-only caller (e.g. `listApps`)
  // must not join — or fail because of — an in-flight `automationReady`
  // setup started by a concurrent caller for the same session. Reaching
  // `ensureReadinessUpgraded` already implies the device itself is booted
  // (`devicePool.assertSessionReadyForAutomation` ran earlier), so a booted
  // caller has nothing to gain from waiting on stricter automation setup and
  // must not inherit its rejection.
  test("a concurrent booted call bypasses (and does not fail from) an in-flight automationReady setup that later rejects (#6227)", async () => {
    let automationSetupCalls = 0;
    let setupEnteredResolve!: () => void;
    const setupEntered = new Promise<void>((resolve) => {
      setupEnteredResolve = resolve;
    });
    let triggerReject!: () => void;
    const rejectSignal = new Promise<void>((resolve) => {
      triggerReject = resolve;
    });

    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          automationSetupCalls += 1;
          setupEnteredResolve();
          await rejectSignal;
          throw new Error("simulated automation setup failure");
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    await sessionManager.createSession("session-booted-bypass", "device-1", "android");

    const automationCall = createToolExecutionContext(
      "session-booted-bypass",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
    );

    // Let the automationReady call actually enter (and register as the
    // in-flight upgrade for) setup before the concurrent booted call starts.
    await setupEntered;

    const bootedContext = await createToolExecutionContext(
      "session-booted-bypass",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "booted" },
    );

    // The booted call must succeed without waiting for the still-pending
    // automationReady setup, and must record the booted baseline itself.
    expect(bootedContext.deviceId).toBe("device-1");
    expect(sessionManager.getDeviceReadiness("session-booted-bypass")).toBe("booted");

    // Now let the automationReady setup actually reject — the booted call
    // above already resolved and must be unaffected by this.
    triggerReject();
    await expect(automationCall).rejects.toThrow();
    expect(automationSetupCalls).toBe(1);
  });

  // #6227 P2 follow-up: the single-flight map must be scoped to the session
  // INCARNATION, not the bare session UUID. A recreated session with the
  // same UUID (e.g. restart recovery re-binding it after a nonterminal
  // release's setup-drain timeout) must never join a stale flight left
  // behind by its predecessor.
  test("scopes the readiness single-flight to the session incarnation, not the bare UUID (#6227 P2 follow-up)", async () => {
    let setupCalls = 0;
    let oldEnteredResolve!: () => void;
    const oldEntered = new Promise<void>((resolve) => {
      oldEnteredResolve = resolve;
    });
    let releaseOldGate!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOldGate = resolve;
    });
    let mode: "old" | "new" = "old";

    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          if (mode === "old") {
            oldEnteredResolve();
            await oldGate;
          }
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    const original = await sessionManager.createSession(
      "session-incarnation-scope",
      "device-1",
      "android",
    );

    // The old incarnation's readiness setup starts and hangs mid-flight — it
    // is never released within this test, standing in for setup that is
    // still pending when the release below reaches its drain timeout.
    const oldCall = createToolExecutionContext(
      "session-incarnation-scope",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
      undefined,
      original,
    );
    await oldEntered;

    // A nonterminal release reaches the ~1s setup-drain timeout while the
    // old incarnation's setup is still pending, and proceeds anyway
    // (fakeTimer auto-advance fires the drain timeout without a real wait).
    await sessionManager.releaseSession("session-incarnation-scope", PLAN_AUTO_RELEASE_REASON);

    // The UUID is recreated as a brand-new incarnation (e.g. restart
    // recovery re-binding it, possibly to a different device).
    const replacement = await sessionManager.createSession(
      "session-incarnation-scope",
      "device-1",
      "android",
    );
    expect(replacement).not.toBe(original);
    mode = "new";

    // The replacement must start its OWN flight rather than joining (and
    // resolving from) the predecessor's still-pending one. It queues behind the
    // old incarnation on the shared per-device readiness lock (#6227 FIX 2), so
    // release the old (now-released) incarnation's hung setup to free that lock;
    // the replacement then runs its own setup (setupCalls -> 2) rather than the
    // predecessor's.
    const newContextPromise = createToolExecutionContext(
      "session-incarnation-scope",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
      undefined,
      replacement,
    );

    releaseOldGate();
    await oldCall.catch(() => {
      // The old incarnation's own call is expected to fail once its setup
      // finally resolves against an already-released session; only the
      // replacement's outcome is under test here.
    });

    const newContext = await newContextPromise;

    expect(newContext.deviceId).toBe("device-1");
    expect(setupCalls).toBe(2);
    expect(sessionManager.getDeviceReadiness("session-incarnation-scope")).toBe("automationReady");
  });

  // #6227 P1 review follow-up: the readiness UPGRADE path must honor
  // `--skip-ctrl-proxy-download` exactly as the fresh acquisition path does.
  // A booted-only session upgraded to automationReady while downloads are
  // disabled and CtrlProxy is NOT installed must refuse (actionable error)
  // rather than trigger `setup()`'s download/install of the missing artifact.
  test("does not download CtrlProxy when upgrading a booted-only session while --skip-ctrl-proxy-download is set (#6227)", async () => {
    let setupCalls = 0;
    let installed = false;
    let versionCompatible = true;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        isInstalled: async () => installed,
        isVersionCompatible: async () => versionCompatible,
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    serverConfig.setSkipCtrlProxyDownload(true);
    try {
      // A booted-only first touch skips accessibility setup entirely.
      const bootedContext = await createToolExecutionContext(
        "session-skip-dl",
        sessionManager,
        devicePool,
        { ...sessionOptions, deviceReadiness: "booted" },
      );
      expect(bootedContext.deviceId).toBe("device-1");
      expect(setupCalls).toBe(0);
      expect(sessionManager.getDeviceReadiness("session-skip-dl")).toBe("booted");

      // Upgrade to automationReady while CtrlProxy is NOT installed: the fresh
      // path fails here rather than downloading, so the upgrade must too —
      // `setup()` (the download/install path) must never run.
      await expect(
        createToolExecutionContext("session-skip-dl", sessionManager, devicePool, {
          ...sessionOptions,
          deviceReadiness: "automationReady",
        }),
      ).rejects.toThrow(/not installed and runner downloads are disabled/);
      expect(setupCalls).toBe(0);
      expect(sessionManager.getDeviceReadiness("session-skip-dl")).toBe("booted");

      // Installed but INCOMPATIBLE version: downloads are disabled, so the
      // incompatible proxy cannot be upgraded. The upgrade must refuse with the
      // version-mismatch actionable error rather than run `setup()` against the
      // incompatible installed proxy.
      installed = true;
      versionCompatible = false;
      await expect(
        createToolExecutionContext("session-skip-dl", sessionManager, devicePool, {
          ...sessionOptions,
          deviceReadiness: "automationReady",
        }),
      ).rejects.toThrow(/CtrlProxy version mismatch/);
      expect(setupCalls).toBe(0);
      expect(sessionManager.getDeviceReadiness("session-skip-dl")).toBe("booted");

      // With the artifact already present AND compatible, the upgrade proceeds
      // without a download (setup runs against an installed package).
      versionCompatible = true;
      const upgraded = await createToolExecutionContext(
        "session-skip-dl",
        sessionManager,
        devicePool,
        { ...sessionOptions, deviceReadiness: "automationReady" },
      );
      expect(upgraded.deviceId).toBe("device-1");
      expect(setupCalls).toBe(1);
      expect(sessionManager.getDeviceReadiness("session-skip-dl")).toBe("automationReady");
    } finally {
      serverConfig.setSkipCtrlProxyDownload(false);
    }
  });

  // #6227 P1 review follow-up: a session-scoped readiness upgrade must
  // participate in the SAME per-device readiness lock the acquisition paths
  // (startDevice/getAndroid/provision, via RunnerReadinessService) hold while
  // preparing a device, so an upgrade and a concurrent device preparation
  // never both reset+setup the shared per-device CtrlProxy manager. Here a
  // concurrent device preparation holds that lock; the upgrade must not run
  // accessibility setup until the preparation releases it.
  test("serializes a session upgrade behind a concurrent device preparation holding the per-device readiness lock (#6227)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    await sessionManager.createSession(
      "session-device-lock",
      "device-1",
      "android",
      AUTO_ADVANCED_SETUP_IDLE_WINDOW_MS,
    );

    // Stand in for a concurrent device preparation (startDevice/getAndroid/
    // provision via RunnerReadinessService) holding the SAME per-device lock.
    const release = await acquireDeviceReadinessLock(deviceReadinessLockKey("android", "device-1"));

    const upgrade = createToolExecutionContext("session-device-lock", sessionManager, devicePool, {
      ...sessionOptions,
      deviceReadiness: "automationReady",
    });

    // While the device preparation holds the lock, the upgrade cannot run
    // accessibility setup — no concurrent reset+setup on the shared manager.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(setupCalls).toBe(0);

    // Once the device preparation releases, the queued upgrade proceeds and
    // runs setup exactly once.
    release();
    const context = await upgrade;
    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
    expect(sessionManager.getDeviceReadiness("session-device-lock")).toBe("automationReady");
  });

  // #6280 P2 review follow-up: a device acquisition (startDevice/getAndroid)
  // releases the per-device readiness lock as soon as CtrlProxy setup
  // finishes — well before it goes on to bind/reuse the session and record
  // its achieved readiness. A concurrent upgrade for that SAME (already
  // reused, post-restart recovered) session must not race a second setup in
  // that gap; it must join the acquisition's marker and observe the recorded
  // readiness once the acquisition finishes.
  test("joins an in-flight device acquisition instead of redoing CtrlProxy setup for a reused session (#6280)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    // A post-restart recovered session: already tracked, readiness never
    // recorded — mirrors a session reused by a concurrent acquisition.
    await sessionManager.createSession(
      "session-acquisition-race",
      "device-1",
      "android",
      AUTO_ADVANCED_SETUP_IDLE_WINDOW_MS,
    );

    // Stand in for a device acquisition that has already released the
    // per-device readiness lock (CtrlProxy setup finished) but has not yet
    // bound/recorded readiness for the reused session.
    let resolveAcquisition!: () => void;
    const acquisitionDone = new Promise<void>((resolve) => {
      resolveAcquisition = resolve;
    });
    const acquisitionPromise = trackDeviceAcquisitionReadiness(
      deviceReadinessLockKey("android", "device-1"),
      async () => {
        await acquisitionDone;
        sessionManager.setDeviceReadiness("session-acquisition-race", "automationReady");
      },
    );

    const upgrade = createToolExecutionContext(
      "session-acquisition-race",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
    );

    // While the acquisition marker is set, the upgrade must wait on it
    // instead of racing its own CtrlProxy setup on the device just prepared.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(setupCalls).toBe(0);

    resolveAcquisition();
    await acquisitionPromise;
    const context = await upgrade;

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(0);
    expect(sessionManager.getDeviceReadiness("session-acquisition-race")).toBe("automationReady");
  });

  test("cancels while queued for a device readiness transaction without starting setup (#6280)", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;
    await sessionManager.createSession("session-cancelled-readiness", "device-1", "android");

    const release = await acquireDeviceReadinessLock(deviceReadinessLockKey("android", "device-1"));
    const controller = new AbortController();
    const context = createToolExecutionContext(
      "session-cancelled-readiness",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
      undefined,
      undefined,
      false,
      controller.signal,
    );

    controller.abort(new Error("request cancelled"));
    await expect(context).rejects.toThrow("request cancelled");
    release();
    expect(setupCalls).toBe(0);
  });

  test("runs session readiness setup with a flight signal that is independent of one requester (#6280)", async () => {
    let setupSignal: AbortSignal | undefined;
    setDeviceReadinessProxyDriverProviderForTesting(() => ({
      resetSetupState: () => {},
      setup: async () => {
        setupSignal = getAbortSignal();
        return { success: true, message: "ok" };
      },
      waitForConnection: async () => true,
      isInstalled: async () => true,
      isVersionCompatible: async () => true,
    }));
    await sessionManager.createSession("session-signal-readiness", "device-1", "android");
    const controller = new AbortController();

    await createToolExecutionContext(
      "session-signal-readiness",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
      undefined,
      undefined,
      false,
      controller.signal,
    );

    expect(setupSignal).toBeDefined();
    expect(setupSignal).not.toBe(controller.signal);
    expect(setupSignal!.aborted).toBe(false);
  });

  test("does not let a cancelled readiness-flight initiator cancel a live joiner (#6280)", async () => {
    let resolveSetup!: () => void;
    const setupStarted = new Promise<void>((resolve) => {
      resolveSetup = resolve;
    });
    let setupCalls = 0;
    setDeviceReadinessProxyDriverProviderForTesting(() => ({
      resetSetupState: () => {},
      setup: async () => {
        setupCalls += 1;
        await setupStarted;
        return { success: true, message: "ok" };
      },
      waitForConnection: async () => true,
      isInstalled: async () => true,
      isVersionCompatible: async () => true,
    }));
    await sessionManager.createSession(
      "session-shared-flight",
      "device-1",
      "android",
      AUTO_ADVANCED_SETUP_IDLE_WINDOW_MS,
    );
    const firstController = new AbortController();
    const first = createToolExecutionContext(
      "session-shared-flight",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
      undefined,
      undefined,
      false,
      firstController.signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const second = createToolExecutionContext("session-shared-flight", sessionManager, devicePool, {
      ...sessionOptions,
      deviceReadiness: "automationReady",
    });
    await new Promise((resolve) => setImmediate(resolve));
    firstController.abort(new Error("first request cancelled"));
    await expect(first).rejects.toThrow("first request cancelled");
    resolveSetup();
    await expect(second).resolves.toMatchObject({ deviceId: "device-1" });
    expect(setupCalls).toBe(1);
  });

  test("joins readiness work after its first caller cancels (#6280, #6400)", async () => {
    let resolveSetup!: () => void;
    const setupStarted = new Promise<void>((resolve) => {
      resolveSetup = resolve;
    });
    const setupEntered = Promise.withResolvers<void>();
    let setupCalls = 0;
    setDeviceReadinessProxyDriverProviderForTesting(() => ({
      resetSetupState: () => {},
      setup: async () => {
        setupCalls += 1;
        setupEntered.resolve();
        await setupStarted;
        return { success: true, message: "ok" };
      },
      waitForConnection: async () => true,
      isInstalled: async () => true,
      isVersionCompatible: async () => true,
    }));
    await sessionManager.createSession("session-cancelled-flight-retry", "device-1", "android");

    const cancelled = new AbortController();
    const first = createToolExecutionContext(
      "session-cancelled-flight-retry",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
      undefined,
      undefined,
      false,
      cancelled.signal,
    );
    await setupEntered.promise;
    cancelled.abort(new Error("first request cancelled"));
    await expect(first).rejects.toThrow("first request cancelled");

    // This request arrives after the first caller has cancelled but before
    // shared setup settles. It joins that flight and observes its result.
    const later = createToolExecutionContext(
      "session-cancelled-flight-retry",
      sessionManager,
      devicePool,
      { ...sessionOptions, deviceReadiness: "automationReady" },
    );
    resolveSetup();

    await expect(later).resolves.toMatchObject({ deviceId: "device-1" });
    expect(setupCalls).toBe(1);
  });

  test("cancelled callers detach while their shared CtrlProxy setup completes (#6400)", async () => {
    const setupEntered = Promise.withResolvers<void>();
    const finishSetup = Promise.withResolvers<void>();
    let resetCalls = 0;
    let setupCalls = 0;
    let completedSetups = 0;
    let setupSignal: AbortSignal | undefined;
    setDeviceReadinessProxyDriverProviderForTesting(() => ({
      resetSetupState: () => {
        resetCalls += 1;
      },
      setup: async () => {
        setupCalls += 1;
        setupSignal = getAbortSignal();
        setupEntered.resolve();
        await finishSetup.promise;
        setupSignal?.throwIfAborted();
        completedSetups += 1;
        return { success: true, message: "ok" };
      },
      waitForConnection: async () => true,
      isInstalled: async () => true,
      isVersionCompatible: async () => true,
    }));
    await sessionManager.createSession("session-shared-cancellation", "device-1", "android");

    const firstController = new AbortController();
    const first = createToolExecutionContext(
      "session-shared-cancellation",
      sessionManager,
      devicePool,
      sessionOptions,
      undefined,
      undefined,
      false,
      firstController.signal,
    );
    await setupEntered.promise;
    expect(resetCalls).toBe(1);
    expect(setupCalls).toBe(1);

    firstController.abort(new Error("first caller cancelled"));
    await expect(first).rejects.toThrow("first caller cancelled");
    expect(setupSignal?.aborted).toBe(false);
    expect(completedSetups).toBe(0);

    const later = createToolExecutionContext(
      "session-shared-cancellation",
      sessionManager,
      devicePool,
      sessionOptions,
    );
    finishSetup.resolve();
    await expect(later).resolves.toMatchObject({ deviceId: "device-1" });
    expect(setupSignal?.aborted).toBe(false);
    expect(completedSetups).toBe(1);
    expect(resetCalls).toBe(1);
    expect(setupCalls).toBe(1);
    expect(sessionManager.getDeviceReadiness("session-shared-cancellation")).toBe(
      "automationReady",
    );
  });

  test("an already-aborted caller does not start shared readiness setup (#6400)", async () => {
    let resetCalls = 0;
    let setupCalls = 0;
    setDeviceReadinessProxyDriverProviderForTesting(() => ({
      resetSetupState: () => {
        resetCalls += 1;
      },
      setup: async () => {
        setupCalls += 1;
        return { success: true, message: "ok" };
      },
      waitForConnection: async () => true,
      isInstalled: async () => true,
      isVersionCompatible: async () => true,
    }));
    await sessionManager.createSession("session-preaborted-readiness", "device-1", "android");
    const controller = new AbortController();
    controller.abort(new Error("cancelled before readiness"));

    await expect(
      createToolExecutionContext(
        "session-preaborted-readiness",
        sessionManager,
        devicePool,
        sessionOptions,
        undefined,
        undefined,
        false,
        controller.signal,
      ),
    ).rejects.toThrow("cancelled before readiness");
    expect(resetCalls).toBe(0);
    expect(setupCalls).toBe(0);
  });

  test("bounds repeated device acquisition readiness setup iterations", async () => {
    let setupCalls = 0;
    let setupPasses = 0;
    const readinessKey = deviceReadinessLockKey("android", "device-1");
    const trackSessionSetup = sessionManager.trackSessionSetup.bind(sessionManager);
    sessionManager.trackSessionSetup = (session, setup) =>
      trackSessionSetup(session, async () => {
        await setup();
        setupPasses += 1;
        let resolveAcquisition!: () => void;
        const acquisitionDone = new Promise<void>((resolve) => {
          resolveAcquisition = resolve;
        });
        void trackDeviceAcquisitionReadiness(readinessKey, () => acquisitionDone);
        fakeTimer.setTimeout(resolveAcquisition, 1);
      });
    setDeviceReadinessProxyDriverProviderForTesting(() => ({
      resetSetupState: () => {},
      setup: async () => {
        setupCalls += 1;
        return { success: true, message: "ok" };
      },
      waitForConnection: async () => true,
      isInstalled: async () => true,
      isVersionCompatible: async () => true,
    }));
    await sessionManager.createSession("session-acquisition-loop-bound", "device-1", "android");

    await expect(
      createToolExecutionContext("session-acquisition-loop-bound", sessionManager, devicePool, {
        ...sessionOptions,
        deviceReadiness: "automationReady",
      }),
    ).rejects.toThrow(/iterations exhausted.*device-1/i);
    expect(setupPasses).toBe(5);
  });

  test("bounds device acquisition setup by elapsed fake time", async () => {
    let setupCalls = 0;
    let setupPasses = 0;
    const readinessKey = deviceReadinessLockKey("android", "device-1");
    const trackSessionSetup = sessionManager.trackSessionSetup.bind(sessionManager);
    sessionManager.trackSessionSetup = (session, setup) =>
      trackSessionSetup(session, async () => {
        await setup();
        setupPasses += 1;
        if (setupPasses === 2) {
          fakeTimer.advanceTime(300_001);
        }
        let resolveAcquisition!: () => void;
        const acquisitionDone = new Promise<void>((resolve) => {
          resolveAcquisition = resolve;
        });
        void trackDeviceAcquisitionReadiness(readinessKey, () => acquisitionDone);
        fakeTimer.setTimeout(resolveAcquisition, 1);
      });
    setDeviceReadinessProxyDriverProviderForTesting(() => ({
      resetSetupState: () => {},
      setup: async () => {
        setupCalls += 1;
        return { success: true, message: "ok" };
      },
      waitForConnection: async () => true,
      isInstalled: async () => true,
      isVersionCompatible: async () => true,
    }));
    await sessionManager.createSession("session-acquisition-deadline", "device-1", "android");

    await expect(
      createToolExecutionContext("session-acquisition-deadline", sessionManager, devicePool, {
        ...sessionOptions,
        deviceReadiness: "automationReady",
      }),
    ).rejects.toThrow(/deadline.*device-1/i);
    expect(setupCalls).toBe(1);
  });

  test("should not run accessibility setup for existing sessions", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;

    await sessionManager.createSession("session-1", "device-1", "android");
    // #6227 P1 follow-up: `undefined` recorded readiness is no longer treated
    // as satisfied on the existingSession path (a session whose readiness was
    // never recorded must not be assumed ready — see isReadinessSatisfied).
    // A direct `SessionManager.createSession` call bypasses this module's own
    // setup entirely, so record the readiness explicitly, exactly as a real
    // setup pass would have by the time a session is genuinely "existing".
    sessionManager.setDeviceReadiness("session-1", "automationReady");
    const context = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      sessionOptions,
    );

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(0);
  });

  test("does not recreate an admitted session released before setup", async () => {
    const admittedSession = await sessionManager.createSession("session-1", "device-1", "android");
    await sessionManager.releaseSession("session-1", "explicit-release");

    await expect(
      createToolExecutionContext(
        "session-1",
        sessionManager,
        devicePool,
        sessionOptions,
        undefined,
        admittedSession,
      ),
    ).rejects.toThrow("Session session-1 was released during setup");
    expect(sessionManager.getSession("session-1")).toBeNull();
  });

  test("quarantines preserved reset-cohort session routing until recovery settles", async () => {
    const first: BootedDevice = {
      name: "Pixel_8_API_35",
      platform: "android",
      deviceId: "emulator-5554",
    };
    const second: BootedDevice = {
      name: "Pixel_9_API_36",
      platform: "android",
      deviceId: "emulator-5556",
    };
    const image = (device: BootedDevice): DeviceInfo => ({
      name: device.name,
      platform: "android",
      isRunning: true,
      source: "local",
    });
    fakeDeviceManager.bootedDevices = [first, second];
    await devicePool.addDevice(first, image(first));
    await devicePool.addDevice(second, image(second));
    await devicePool.bindOrReuseDeviceSession(
      "reset-session-1",
      first.deviceId,
      "android",
      image(first),
    );
    await devicePool.bindOrReuseDeviceSession(
      "reset-session-2",
      second.deviceId,
      "android",
      image(second),
    );
    const detached = await devicePool.detachAdbServerResetCohort([
      devicePool.getDevice(first.deviceId)!,
      devicePool.getDevice(second.deviceId)!,
    ]);

    try {
      await expect(
        createToolExecutionContext("reset-session-2", sessionManager, devicePool, sessionOptions),
      ).rejects.toThrow(/device-disconnected:emulator-5556;incident=/);
    } finally {
      await devicePool.releaseAdbServerResetCohortReservations(detached.devices);
    }

    expect(() => devicePool.assertSessionReadyForAutomation("reset-session-2")).toThrow(
      /device-disconnected:emulator-5556;incident=/,
    );
    await sessionManager.releaseSession("reset-session-2", "explicit-release");
    expect(() => devicePool.assertSessionReadyForAutomation("reset-session-2")).not.toThrow();
  });

  test("retains an implicit autolock mapping while its reset cohort is quarantined", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const device: BootedDevice = {
      name: "Pixel_8_API_35",
      platform: "android",
      deviceId: "emulator-5554",
    };
    const image: DeviceInfo = {
      name: device.name,
      platform: "android",
      isRunning: true,
      source: "local",
    };
    fakeDeviceManager.bootedDevices = [device];
    await devicePool.addDevice(device, image);
    const sessionId = await devicePool.autolockDevice(
      device.deviceId,
      "android",
      "mcp-session",
      image,
    );
    const detached = await devicePool.detachAdbServerResetCohort([
      devicePool.getDevice(device.deviceId)!,
    ]);

    try {
      expect(devicePool.resolveAutolockSessionForMcpSession("mcp-session", "android")).toBe(
        sessionId,
      );
      await expect(
        createToolExecutionContext(sessionId, sessionManager, devicePool, sessionOptions),
      ).rejects.toThrow(/device-disconnected:emulator-5554;incident=/);
      expect(devicePool.resolveAutolockSessionForMcpSession("mcp-session", "android")).toBe(
        sessionId,
      );
    } finally {
      await devicePool.releaseAdbServerResetCohortReservations(detached.devices);
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    }
  });

  test("runs first-session setup when a released UUID is recreated during context creation", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    const original = await sessionManager.createSession("session-recreated", "device-1", "android");
    let finishSetup!: () => void;
    const setup = sessionManager.trackSessionSetup(
      original,
      () =>
        new Promise<void>((resolve) => {
          finishSetup = resolve;
        }),
    );
    const release = sessionManager.releaseSession("session-recreated", PLAN_AUTO_RELEASE_REASON);
    await Promise.resolve();
    const context = createToolExecutionContext(
      "session-recreated",
      sessionManager,
      devicePool,
      sessionOptions,
    );
    finishSetup();
    await setup;
    await release;

    await expect(context).resolves.toMatchObject({ deviceId: "device-1" });
    expect(setupCalls).toBe(1);
  });

  test("rejects an admitted session once its release begins", async () => {
    const session = await sessionManager.createSession("session-releasing", "device-1", "android");
    let finishSetup!: () => void;
    const setup = sessionManager.trackSessionSetup(
      session,
      () =>
        new Promise<void>((resolve) => {
          finishSetup = resolve;
        }),
    );
    const release = sessionManager.releaseSession("session-releasing");
    await Promise.resolve();

    await expect(
      createToolExecutionContext(
        "session-releasing",
        sessionManager,
        devicePool,
        sessionOptions,
        undefined,
        session,
      ),
    ).rejects.toThrow("released during setup");

    finishSetup();
    await setup;
    await release;
  });

  test("rechecks admission after setup releases its session", async () => {
    const session = await sessionManager.createSession("session-releasing", "device-1", "android");
    // #6227 P1 follow-up: `undefined` readiness is no longer treated as
    // satisfied on the existingSession path, so record it explicitly here —
    // this test exercises the post-setup admission recheck, not accessibility
    // setup, and must not make a real CtrlProxy/adb call.
    sessionManager.setDeviceReadiness("session-releasing", "automationReady");
    const trackSetup = spyOn(sessionManager, "trackSessionSetup").mockImplementation(
      async (trackedSession, setup) => {
        await setup();
        await sessionManager.releaseSession(trackedSession.sessionId, "explicit-release");
      },
    );

    try {
      await expect(
        createToolExecutionContext(
          "session-releasing",
          sessionManager,
          devicePool,
          sessionOptions,
          undefined,
          session,
        ),
      ).rejects.toThrow("released during setup");
    } finally {
      trackSetup.mockRestore();
    }
  });

  test("does not apply keep-awake after a session is released during setup", async () => {
    let allowActivityWrite!: () => void;
    const activityWrite = new Promise<void>((resolve) => {
      allowActivityWrite = resolve;
    });
    let activityStarted!: () => void;
    const activityStartedPromise = new Promise<void>((resolve) => {
      activityStarted = resolve;
    });
    const repository = {
      async upsertActiveSession(): Promise<void> {},
      async recordActivity(): Promise<void> {
        activityStarted();
        await activityWrite;
      },
      async markReleased(): Promise<void> {},
      async markStaleActiveSessionsExpired(): Promise<void> {},
    };
    const manager = new SessionManager(fakeTimer, repository);
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "test-daemon-session-id", {
        timer: fakeTimer,
        installedAppsRepository: fakeAppsRepo,
        deviceManager: new FakeDeviceManager(),
      }),
    );
    const applySpy = spyOn(KeepScreenAwakeManager.prototype, "apply").mockResolvedValue({
      applied: false,
      skipReason: "disabled",
    });

    try {
      await pool.initializeWithDevices([createBootedDevice("device-race")]);
      await manager.createSession("session-race", "device-race", "android");

      const context = createToolExecutionContext("session-race", manager, pool, sessionOptions);
      await activityStartedPromise;
      await manager.releaseSession("session-race");
      allowActivityWrite();

      await expect(context).rejects.toThrow("released during setup");
      expect(applySpy).not.toHaveBeenCalled();
    } finally {
      applySpy.mockRestore();
      manager.stopCleanupTimer();
    }
  });

  test("bounds accessibility setup and rejects it after the session releases", async () => {
    const boundedTimer = new FakeTimer();
    const boundedSessionManager = new SessionManager(boundedTimer, {
      async upsertActiveSession(): Promise<void> {},
      async recordActivity(): Promise<void> {},
      async markReleased(): Promise<void> {},
      async markStaleActiveSessionsExpired(): Promise<void> {},
    });
    const boundedDeviceManager = new FakeDeviceManager();
    boundedDeviceManager.bootedDevices = [createBootedDevice("device-1")];
    const boundedPool = new DevicePool(
      createDevicePoolDependencies(boundedSessionManager, "test-daemon-session-id", {
        timer: boundedTimer,
        installedAppsRepository: fakeAppsRepo,
        deviceManager: boundedDeviceManager,
      }),
    );
    await boundedPool.initializeWithDevices([createBootedDevice("device-1")]);
    let finishSetup!: () => void;
    const setupFinished = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });
    let setupStarted!: () => void;
    const setupStartedPromise = new Promise<void>((resolve) => {
      setupStarted = resolve;
    });
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupStarted();
          await setupFinished;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      resetConnectionBudget: () => {},
      close: async () => {},
    })) as any;

    try {
      const context = createToolExecutionContext(
        "session-setup-race",
        boundedSessionManager,
        boundedPool,
        sessionOptions,
      );
      await setupStartedPromise;
      const release = boundedSessionManager.releaseSession("session-setup-race");
      for (
        let attempt = 0;
        attempt < 10 && !boundedTimer.getPendingTimeouts().includes(1_000);
        attempt++
      ) {
        await Promise.resolve();
      }
      expect(boundedTimer.getPendingTimeouts()).toContain(1_000);
      boundedTimer.advanceTime(1_000);
      let releasedDevice: string | null | undefined;
      void release.then((deviceId) => {
        releasedDevice = deviceId;
      });
      for (let attempt = 0; attempt < 10 && releasedDevice === undefined; attempt++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(releasedDevice).toBe("device-1");
      await boundedPool.releaseDevice("device-1", "session-setup-race");

      expect(boundedSessionManager.getSession("session-setup-race")).toBeNull();
      expect(boundedPool.getDevice("device-1")).toMatchObject({
        sessionId: "session-setup-race",
        status: "busy",
      });

      finishSetup();
      await expect(context).rejects.toThrow("released during setup");
      await Promise.resolve();
      expect(boundedPool.getDevice("device-1")).toMatchObject({
        sessionId: null,
        status: "idle",
      });
    } finally {
      boundedSessionManager.stopCleanupTimer();
    }
  });

  // #6069: A never-issued sessionUuid reaching the device-tool path must be
  // rejected even when the caller's connection already holds a live session —
  // the residual of #6019 that #6045 left open. `requireIssuedSession` is the
  // flag toolRegistry sets for exactly this (caller-provided) path.
  describe("rejects an unissued sessionUuid on the device-tool path (#6069)", () => {
    const nonTerminalPersisted = (sessionUuid: string, deviceId: string): DeviceSession => ({
      session_uuid: sessionUuid,
      device_id: deviceId,
      stable_device_id: deviceId,
      platform: "android",
      status: "active",
      source: null,
      autolock_enabled: 0,
      mcp_session_id: null,
      daemon_session_id: "old-daemon",
      created_at_ms: 1,
      last_used_at_ms: 20,
      expires_at_ms: 30,
      released_at_ms: 25,
      release_reason: "daemon-restart",
      session_timeout_ms: 10,
      heartbeat_timeout_ms: 5,
      has_received_heartbeat: 1,
      created_at: "2026-09-03T00:00:00.000Z",
      updated_at: "2026-09-03T00:00:00.000Z",
    });

    test("rejects a fabricated UUID and never assigns a pooled device while a session is active", async () => {
      let setupCalls = 0;
      AndroidCtrlProxyManager.getInstance = () =>
        ({
          resetSetupState: () => {},
          setup: async () => {
            setupCalls += 1;
            return { success: true, message: "ok" };
          },
        }) as any;
      AndroidCtrlProxyClient.getInstance = (() => ({
        waitForConnection: async () => true,
        resetConnectionBudget: () => {},
        close: async () => {},
      })) as any;

      // The connection already holds a live, issued session on device-1.
      await devicePool.assignDeviceToSession("issued-session", "android");
      expect(sessionManager.getSession("issued-session")?.assignedDevice).toBe("device-1");

      const assignSpy = spyOn(devicePool, "assignDeviceToSession");

      await expect(
        createToolExecutionContext(
          "kumquat-D",
          sessionManager,
          devicePool,
          sessionOptions,
          undefined,
          undefined,
          true, // requireIssuedSession — the device-tool boundary
        ),
      ).rejects.toThrow(/not an active daemon session/);

      // No pooled device was minted for the fabricated id, and the caller's own
      // live session is untouched.
      expect(assignSpy).not.toHaveBeenCalled();
      expect(sessionManager.getSession("kumquat-D")).toBeNull();
      expect(sessionManager.getSession("issued-session")?.assignedDevice).toBe("device-1");
      expect(setupCalls).toBe(0);
      assignSpy.mockRestore();
    });

    test("still recovers a persisted, non-terminal session (live-during-restart)", async () => {
      AndroidCtrlProxyManager.getInstance = () =>
        ({
          resetSetupState: () => {},
          setup: async () => ({ success: true, message: "ok" }),
        }) as any;
      AndroidCtrlProxyClient.getInstance = (() => ({
        waitForConnection: async () => true,
        resetConnectionBudget: () => {},
        close: async () => {},
      })) as any;

      const persisted = nonTerminalPersisted("restarted-session", "device-1");
      const recoveryManager = new SessionManager(fakeTimer, {
        async getSession() {
          return persisted;
        },
        async upsertActiveSession() {},
        async recordActivity() {},
        async markReleased() {},
      });
      const recoveryPool = new DevicePool(
        createDevicePoolDependencies(recoveryManager, "test-daemon-session-id", {
          timer: fakeTimer,
          installedAppsRepository: fakeAppsRepo,
          deviceManager: fakeDeviceManager,
        }),
      );
      await recoveryPool.initializeWithDevices([createBootedDevice("device-1")]);

      try {
        const context = await createToolExecutionContext(
          "restarted-session",
          recoveryManager,
          recoveryPool,
          sessionOptions,
          undefined,
          undefined,
          true, // requireIssuedSession must NOT block restart recovery
        );
        expect(context.deviceId).toBe("device-1");
        expect(recoveryManager.getSession("restarted-session")?.assignedDevice).toBe("device-1");
      } finally {
        recoveryManager.stopCleanupTimer();
      }
    });

    test("the caller's own issued session still resolves without a new assignment", async () => {
      AndroidCtrlProxyManager.getInstance = () =>
        ({
          resetSetupState: () => {},
          setup: async () => ({ success: true, message: "ok" }),
        }) as any;
      AndroidCtrlProxyClient.getInstance = (() => ({
        waitForConnection: async () => true,
        resetConnectionBudget: () => {},
        close: async () => {},
      })) as any;

      await sessionManager.createSession("mine", "device-1", "android");
      const assignSpy = spyOn(devicePool, "assignDeviceToSession");

      const context = await createToolExecutionContext(
        "mine",
        sessionManager,
        devicePool,
        sessionOptions,
        undefined,
        undefined,
        true,
      );

      expect(context.deviceId).toBe("device-1");
      expect(assignSpy).not.toHaveBeenCalled();
      assignSpy.mockRestore();
    });

    test("device-label / internal fresh mint is unaffected (requireIssuedSession defaults false)", async () => {
      AndroidCtrlProxyManager.getInstance = () =>
        ({
          resetSetupState: () => {},
          setup: async () => ({ success: true, message: "ok" }),
        }) as any;
      AndroidCtrlProxyClient.getInstance = (() => ({
        waitForConnection: async () => true,
        resetConnectionBudget: () => {},
        close: async () => {},
      })) as any;

      // Mirrors deviceLabelMapping.registerDeviceLabelMap, which mints a fresh
      // derived session without passing requireIssuedSession.
      const context = await createToolExecutionContext(
        "base:B",
        sessionManager,
        devicePool,
        sessionOptions,
      );
      expect(context.deviceId).toBe("device-1");
      expect(sessionManager.getSession("base:B")?.assignedDevice).toBe("device-1");
    });
  });
});
