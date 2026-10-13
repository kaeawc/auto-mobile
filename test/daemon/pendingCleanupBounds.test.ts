import { afterEach, expect, spyOn, test } from "bun:test";
import * as releaseBudgets from "../../src/daemon/sessionManager";
import { SESSION_RELEASE_DRAIN_TIMEOUT_MS } from "../../src/daemon/constants";
import { SCREEN_READER_RESTORE_TIMEOUT_MS } from "../../src/features/accessibility/ScreenReaderRestore";
import { defaultDeviceClockRestoreRegistry } from "../../src/features/utility/DeviceClock";
import {
  SessionManager,
  SESSION_RELEASE_TEARDOWN_CAP_MS,
  getSessionReleaseCleanupWorstCaseMs,
  type DeviceStateRestorerFactories,
  type SessionCacheData,
} from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceCleanupInProgressError } from "../../src/daemon/deviceAcquisitionRefusals";
import { registerNetworkStateSessionCleanup } from "../../src/server/networkStateSessionCleanup";
import { NetworkState } from "../../src/server/NetworkState";
import { MockLocationClearRegistry } from "../../src/features/utility/MockLocationClear";
import {
  LocationRouteRegistry,
  registerLocationRouteSessionCleanup,
} from "../../src/features/utility/LocationRoutePlayer";
import { createSessionLocationAppliedCallback } from "../../src/server/sessionLocation";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import {
  SessionHeartbeatMonitor,
  STUCK_REAP_WARN_MS,
} from "../../src/daemon/SessionHeartbeatMonitor";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  getSessionHeartbeatCheckIntervalMs,
} from "../../src/daemon/sessionLivenessWindows";
import { forceStuckSessionRelease } from "../../src/daemon/releaseSessionAndDevice";
import type { DeviceSessionRecord } from "../../src/db/deviceSessionRepository";
import { ExecutionTracker } from "../../src/server/executionTracker";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { UNSETTLED_EXECUTION_DEADLINE_GRACE_MS } from "../../src/daemon/unsettledExecutionVeto";
import type { DeferredRebindCleanup } from "../../src/daemon/acquisitionReceipt";

const device = {
  deviceId: "12345678-1234-1234-1234-123456789ABC",
  name: "iPhone",
  platform: "ios" as const,
};
const android = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
const cap = SESSION_RELEASE_TEARDOWN_CAP_MS;
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of dispose.splice(0).reverse()) {
    cleanup();
  }
});

function harness(
  persistence = new FakeDeviceSessionPersistence(),
  restorers?: DeviceStateRestorerFactories,
) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000_000);
  const manager = new SessionManager(
    timer,
    persistence,
    () => new FakeDbWriteBarrier(),
    undefined,
    undefined,
    restorers,
  );
  const deviceManager = new FakeDeviceUtils();
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "cleanup-bounds", {
      timer,
      deviceManager,
      installedAppsRepository: new FakeInstalledAppsRepository(),
    }),
  );
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  dispose.push(() => {
    manager.stopCleanupTimer();
    timer.reset();
    warn.mockRestore();
  });
  return { timer, manager, pool, deviceManager, warn };
}
type Harness = ReturnType<typeof harness>;
const flush = () => drainMicrotasks(100);

async function deferredRebindHarness(
  state: SessionCacheData = { networkCondition: { initialProfile: "none" } },
  wedged?: "network and clock" | "clock",
  restorers?: DeviceStateRestorerFactories,
) {
  const calls: string[] = [];
  const clockSignals: Array<AbortSignal | undefined> = [];
  const restore = Promise.withResolvers<void>();
  const h = harness(undefined, {
    networkCondition: () => ({
      restore: async () => {
        calls.push("network");
        if (wedged === "network and clock") {
          await restore.promise;
        }
      },
    }),
    clock: () => ({
      restore: async (_state, signal) => {
        calls.push("clock");
        clockSignals.push(signal);
        if (wedged) {
          await restore.promise;
        }
      },
    }),
    screenReader: () => ({
      restore: async () => {
        calls.push("screenReader");
      },
    }),
    ...restorers,
  });
  dispose.push(() => {
    restore.resolve();
    defaultDeviceClockRestoreRegistry.retire(android.deviceId);
  });
  await h.manager.createSession("rebound", android.deviceId, "android", 600_000, 600_000);
  h.manager.updateSessionCache("rebound", state);
  const pendingTimeouts = h.timer.getPendingTimeoutCount();
  let cleanup: DeferredRebindCleanup | undefined;
  await h.manager.rebindSession("rebound", "emulator-5556", "android", {
    deferCleanup: (value) => {
      cleanup = value;
    },
  });
  if (!cleanup) {
    throw new Error("Rebind did not provide deferred cleanup");
  }
  const bound = h.manager.getDeviceCleanupRetryAfterMs(android.deviceId);
  const deadlineWarnings = () =>
    h.warn.mock.calls.filter(([message]) => message.includes("Deferred rebind cleanup deadline"));
  return { ...h, cleanup, calls, clockSignals, bound, pendingTimeouts, deadlineWarnings, restore };
}

const gateCap = releaseBudgets.SESSION_CREATE_WAIT_TIMEOUT_MS + cap;

for (const wedged of ["network and clock", "clock"] as const) {
  test(`deferred rebind hands off quarantine before a wedged ${wedged} restore`, async () => {
    const h = await deferredRebindHarness(
      {
        ...(wedged === "network and clock" && { networkCondition: { initialProfile: "none" } }),
        clock: { initialAutomaticTime: 1, clockChangedByUs: true, rootedByUs: false },
      },
      wedged,
    );
    h.cleanup.commit();
    let gateSettled = false;
    void h.cleanup.settled.then(() => {
      gateSettled = true;
    });
    expect(h.cleanup.cancel()).toBe(false);
    const pending = h.manager.getPendingDeviceCleanup(android.deviceId);
    let pendingSettled = false;
    void pending?.then(() => {
      pendingSettled = true;
    });
    await flush();
    expect(gateSettled).toBe(true);
    expect(pendingSettled).toBe(false);
    await h.timer.advanceTimeAsync(gateCap + 10_000, flush);
    expect(pendingSettled).toBe(false);
    expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(true);
    expect(() => h.pool.assertDeviceCleanupComplete(android.deviceId)).toThrow(
      DeviceCleanupInProgressError,
    );
    expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(1_000);
    expect(h.clockSignals[0]?.aborted).toBe(false);
    expect(h.deadlineWarnings()).toHaveLength(0);
    h.restore.resolve();
    await pending;
    await flush();
    expect(pendingSettled).toBe(true);
    expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(false);
  });
}

test("retained undo deadline starts quarantined restores and rejects late outcomes", async () => {
  const h = await deferredRebindHarness(
    { clock: { initialAutomaticTime: 1, clockChangedByUs: true, rootedByUs: false } },
    "clock",
  );
  expect(h.bound).toBe(gateCap);
  expect(h.cleanup.cancel()).toBe(true);
  await h.timer.advanceTimeAsync(gateCap - 1, flush);
  expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(1);
  expect(h.calls).toEqual([]);
  await h.timer.advanceTimeAsync(1, flush);
  await h.cleanup.settled;
  expect(h.cleanup.retained).toBe(false);
  expect(h.calls).toEqual(["clock"]);
  expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(true);
  expect(h.deadlineWarnings()).toHaveLength(1);
  expect(h.deadlineWarnings()[0]?.[0]).toContain(android.deviceId);
  expect(h.deadlineWarnings()[0]?.[0]).toContain(`${gateCap}ms`);
  expect(h.deadlineWarnings()[0]?.[0]).toContain("undo did not finish in time");
  h.cleanup.finish("failed");
  h.cleanup.finish("rebound");
  h.cleanup.commit();
  await flush();
  expect(h.cleanup.retained).toBe(false);
  expect(h.calls).toEqual(["clock"]);
  expect(h.deadlineWarnings()).toHaveLength(1);
});

for (const retained of [false, true]) {
  test(`empty deferred gate ${retained ? "retained" : "orphaned"} admits its device within its bound`, async () => {
    const h = await deferredRebindHarness({});
    expect(h.bound).toBe(gateCap);
    if (retained) {
      expect(h.cleanup.cancel()).toBe(true);
    }
    await h.timer.advanceTimeAsync(1_000, flush);
    expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(gateCap - 1_000);
    await h.timer.advanceTimeAsync(gateCap - 1_000, flush);
    await h.cleanup.settled;
    expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(false);
    expect(() => h.pool.assertDeviceCleanupComplete(android.deviceId)).not.toThrow();
    h.cleanup.finish("failed");
    h.cleanup.finish("rebound");
    h.cleanup.commit();
    await flush();
    expect(h.calls).toEqual([]);
  });
}

for (const kind of ["screenReader", "clock"] as const) {
  test(`orphaned rebind quarantines every failing ${kind} dispatch until its own cleanup ends`, async () => {
    const safe: boolean[] = [];
    let failing = true;
    const state: SessionCacheData =
      kind === "clock"
        ? { clock: { initialAutomaticTime: 1, clockChangedByUs: true, rootedByUs: false } }
        : { screenReader: { platform: "android", previousEnabled: false } };
    const h = await deferredRebindHarness(state, undefined, {
      [kind]: () => ({
        restore: async () => {
          safe.push(h.manager.hasDeviceCleanupInProgress(android.deviceId));
          if (kind === "screenReader") {
            await h.timer.sleep(30_000);
          }
          if (failing) {
            throw new Error("restore not confirmed");
          }
        },
      }),
    });
    const observe = async () => {
      await flush();
      if (h.manager.getPendingDeviceCleanup(android.deviceId)) {
        expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(true);
        expect(() => h.pool.assertDeviceCleanupComplete(android.deviceId)).toThrow(
          DeviceCleanupInProgressError,
        );
      }
    };
    await h.timer.advanceTimeAsync(gateCap + 25_000, observe);
    expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(true);
    expect(() => h.pool.assertDeviceCleanupComplete(android.deviceId)).toThrow(
      DeviceCleanupInProgressError,
    );
    if (kind === "screenReader") {
      await h.timer.advanceTimeAsync(65_000, observe);
    }
    if (kind === "clock") {
      failing = false;
    }
    await h.timer.advanceTimeAsync(160_000, observe);
    expect(safe.length).toBeGreaterThan(1);
    expect(safe.every(Boolean)).toBe(true);
    expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(false);
  });
}

test("shutdown flush waits for the deferred restore handoff", async () => {
  const h = await deferredRebindHarness(
    { clock: { initialAutomaticTime: 1, clockChangedByUs: true, rootedByUs: false } },
    "clock",
  );
  let drained = false;
  const drain = h.manager.drainPendingDeviceCleanups(1_000).then((value) => {
    drained = true;
    return value;
  });
  await flush();
  expect(drained).toBe(false);
  await h.timer.advanceTimeAsync(1_000, flush);
  expect(await drain).toBe(false);
  expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(true);
});

test("cancel after handoff joins the restore run and its pending retry", async () => {
  const retry = Promise.withResolvers<void>();
  let calls = 0;
  const h = await deferredRebindHarness(
    { clock: { initialAutomaticTime: 1, clockChangedByUs: true, rootedByUs: false } },
    undefined,
    {
      clock: () => ({
        restore: async () => {
          calls++;
          if (calls === 1) {
            throw new Error("first attempt failed");
          }
          await retry.promise;
        },
      }),
    },
  );
  dispose.push(() => retry.resolve());
  h.cleanup.commit();
  let gateSettled = false;
  void h.cleanup.settled.then(() => {
    gateSettled = true;
  });
  expect(h.cleanup.cancel()).toBe(false);
  const pending = h.manager.getPendingDeviceCleanup(android.deviceId);
  let settled = false;
  void pending?.then(() => {
    settled = true;
  });
  await flush();
  expect(calls).toBe(1);
  expect(gateSettled).toBe(true);
  expect(settled).toBe(false);
  await h.timer.advanceTimeAsync(1_000, flush);
  expect(calls).toBe(2);
  expect(settled).toBe(false);
  expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(true);
  retry.resolve();
  await pending;
  await flush();
  expect(settled).toBe(true);
  expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(false);
});

test("a deferred restore handoff keeps a capped pending retry's actual remaining bound", async () => {
  const retry = Promise.withResolvers<void>();
  let calls = 0;
  dispose.push(() => retry.resolve());
  const h = await deferredRebindHarness(undefined, undefined, {
    networkCondition: () => ({
      restore: async () => {
        calls++;
        if (calls === 1) {
          throw new Error("network restore failed");
        }
        await retry.promise;
      },
    }),
  });
  h.cleanup.commit();
  await flush();
  expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(cap);
  await h.timer.advanceTimeAsync(2_000, flush);
  expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(cap - 2_000);
  expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(true);
  await h.timer.advanceTimeAsync(cap - 2_000, flush);
  expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(false);
});

test("deferred rebind settled restores open immediately and clear every gate timeout", async () => {
  const h = await deferredRebindHarness();
  h.cleanup.commit();
  await h.cleanup.settled;
  await flush();
  expect(h.calls).toEqual(["network"]);
  expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(false);
  expect(h.timer.getPendingTimeoutCount()).toBe(h.pendingTimeouts);
  await h.timer.advanceTimeAsync(h.bound, flush);
  expect(h.deadlineWarnings()).toHaveLength(0);
});

test("deferred rebind soft timer still commits restores at the creation wait", async () => {
  const h = await deferredRebindHarness();
  await h.timer.advanceTimeAsync(releaseBudgets.SESSION_CREATE_WAIT_TIMEOUT_MS - 1, flush);
  expect(h.calls).toEqual([]);
  expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(true);
  await h.timer.advanceTimeAsync(1, flush);
  await h.cleanup.settled;
  expect(h.calls).toEqual(["network"]);
  expect(h.timer.getPendingTimeoutCount()).toBe(h.pendingTimeouts);
  expect(h.deadlineWarnings()).toHaveLength(0);
});

test("deferred rebind successful undo opens the gate and clears the hard deadline", async () => {
  const h = await deferredRebindHarness();
  expect(h.cleanup.cancel()).toBe(true);
  h.cleanup.finish("rebound");
  await h.cleanup.settled;
  await flush();
  expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(false);
  expect(h.timer.getPendingTimeoutCount()).toBe(h.pendingTimeouts);
  await h.timer.advanceTimeAsync(h.bound, flush);
  expect(h.calls).toEqual([]);
  expect(h.deadlineWarnings()).toHaveLength(0);
});

for (const [reason, forced] of [
  ["cleanup-expired", false],
  ["plan-auto-release", false],
  ["explicit-release", true],
  ["explicit-release", false],
] as const) {
  test(`terminal release enumeration partitions ${reason} and excludes it after ${forced ? "force" : "settlement"}`, async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const h = harness(persistence);
    await h.manager.createSession("old", android.deviceId, "android", 600_000, 600_000);
    const gate = Promise.withResolvers<void>();
    const write = spyOn(persistence, "markReleased").mockImplementation(() => gate.promise);
    dispose.push(() => write.mockRestore());
    const startedAtMs = h.timer.now();
    const release = h.manager.releaseSession(
      "old",
      reason,
      false,
      undefined,
      reason === "cleanup-expired" ? { expiryOrigin: "cleanup-expired" } : undefined,
    );
    await flush();
    const entry = { sessionId: "old", startedAtMs };
    expect(h.manager.getTerminalReleasesInProgress()).toEqual(
      reason === "explicit-release" ? [entry] : [],
    );
    expect(h.manager.getIdleReleasesInProgress()).toEqual(
      reason === "cleanup-expired" ? [entry] : [],
    );
    expect(
      h.manager.getNonTerminalReleasesInProgress().map(({ session: _session, ...item }) => item),
    ).toEqual(reason === "plan-auto-release" ? [entry] : []);
    if (forced) {
      h.manager.forceStuckRelease("old");
      expect(h.manager.getTerminalReleasesInProgress()).toEqual([]);
    }
    gate.resolve();
    await release;
    expect(h.manager.getTerminalReleasesInProgress()).toEqual([]);
    expect(h.manager.isReleaseInProgress("old", startedAtMs)).toBe(false);
  });
}

test("the stuck deadline derives from first attempts and two shutdown-safe writes", () => {
  expect(releaseBudgets.SESSION_RELEASE_STUCK_DEADLINE_MS).toBeLessThanOrEqual(20_000);
  expect(releaseBudgets.SESSION_RELEASE_STUCK_DEADLINE_MS).toBe(
    releaseBudgets.SESSION_SETUP_DRAIN_TIMEOUT_MS +
      releaseBudgets.KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS +
      releaseBudgets.BIOMETRIC_ENROLLMENT_RESTORE_TIMEOUT_MS +
      releaseBudgets.NETWORK_CONDITION_RESTORE_TIMEOUT_MS +
      2 * releaseBudgets.SESSION_RELEASE_PERSIST_TIMEOUT_MS +
      releaseBudgets.SESSION_RELEASE_STUCK_MARGIN_MS,
  );
  expect(releaseBudgets.SESSION_RELEASE_PERSIST_TIMEOUT_MS).toBeGreaterThan(
    SESSION_RELEASE_DRAIN_TIMEOUT_MS,
  );
  expect(releaseBudgets.SESSION_RELEASE_PERSIST_TIMEOUT_MS).toBe(
    SESSION_RELEASE_DRAIN_TIMEOUT_MS + 1_000,
  );
  expect(getSessionReleaseCleanupWorstCaseMs({})).toBe(32_000);
});

test("each own-budget restore adds exactly its first-attempt deadline", () => {
  const clock = { initialAutomaticTime: 1, clockChangedByUs: true, rootedByUs: true };
  const rotation = { accelerometerRotation: 1, userRotation: 0 };
  const screenReader = { platform: "android" as const, previousEnabled: false };
  const base = releaseBudgets.SESSION_RELEASE_STUCK_DEADLINE_MS;
  expect(releaseBudgets.getSessionReleaseStuckDeadlineMs()).toBe(base);
  for (const [state, extra] of [
    [{ clock }, releaseBudgets.CLOCK_RESTORE_TIMEOUT_MS],
    [{ rotation }, releaseBudgets.NETWORK_CONDITION_RESTORE_TIMEOUT_MS],
    [{ screenReader }, SCREEN_READER_RESTORE_TIMEOUT_MS],
    [
      { clock, rotation, screenReader },
      releaseBudgets.CLOCK_RESTORE_TIMEOUT_MS +
        releaseBudgets.NETWORK_CONDITION_RESTORE_TIMEOUT_MS +
        SCREEN_READER_RESTORE_TIMEOUT_MS,
    ],
  ] as const) {
    expect(releaseBudgets.getSessionReleaseStuckDeadlineMs(state)).toBe(base + extra);
    expect(getSessionReleaseCleanupWorstCaseMs({}, state)).toBe(
      base + extra + 2 * getSessionHeartbeatCheckIntervalMs({}) + cap,
    );
  }
});

test("a row write landing just inside its budget settles without a monitor force", async () => {
  const persistence = new FakeDeviceSessionPersistence();
  const h = harness(persistence);
  await h.manager.createSession("old", android.deviceId, "android");
  const gate = Promise.withResolvers<void>();
  const write = spyOn(persistence, "markReleased").mockImplementation(() => gate.promise);
  const force = spyOn(h.manager, "forceStuckRelease");
  dispose.push(() => {
    write.mockRestore();
    force.mockRestore();
  });
  const monitor = new SessionHeartbeatMonitor(
    h.manager,
    () => false,
    async () => {},
    h.timer,
    {
      forceStuckRelease: (id) => forceStuckSessionRelease(h.manager, h.pool, id),
    },
  );
  monitor.start();
  dispose.push(() => {
    void monitor.stop();
  });
  const start = h.timer.now();
  const release = h.manager.releaseSession("old", "plan-auto-release");
  await flush();
  expect(write).toHaveBeenCalledTimes(1);
  expect(h.manager.getReleaseStuckAtMs("old")).toBe(
    start + releaseBudgets.SESSION_RELEASE_STUCK_DEADLINE_MS,
  );
  await h.timer.advanceTimeAsync(releaseBudgets.SESSION_RELEASE_PERSIST_TIMEOUT_MS - 1, flush);
  gate.resolve();
  expect(await release).toBe(android.deviceId);
  await monitor.tick();
  expect(force).not.toHaveBeenCalled();
  expect(h.manager.getReleaseStuckAtMs("old")).toBeUndefined();
});

test("a clock restore retains its recorded budget after clearing its cache mid-release", async () => {
  const persistence = new FakeDeviceSessionPersistence();
  const restored = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const h = harness(persistence, {
    networkCondition: () => ({ restore: async () => {} }),
    clock: () => ({
      restore: async (_state, abort) => {
        signal = abort;
        await restored.promise;
      },
    }),
  });
  dispose.push(() => defaultDeviceClockRestoreRegistry.retire(android.deviceId));
  const session = await h.manager.createSession("old", android.deviceId, "android");
  const clock = { initialAutomaticTime: 1, clockChangedByUs: true, rootedByUs: true };
  h.manager.setClock(session, clock);
  const row = Promise.withResolvers<void>();
  const write = spyOn(persistence, "markReleased").mockImplementation(() => row.promise);
  const force = spyOn(h.manager, "forceStuckRelease");
  dispose.push(() => {
    write.mockRestore();
    force.mockRestore();
  });
  const monitor = new SessionHeartbeatMonitor(
    h.manager,
    () => false,
    async () => {},
    h.timer,
    {
      forceStuckRelease: (id) => forceStuckSessionRelease(h.manager, h.pool, id),
    },
  );
  monitor.start();
  dispose.push(() => {
    void monitor.stop();
  });
  const start = h.timer.now();
  const budget =
    releaseBudgets.SESSION_RELEASE_STUCK_DEADLINE_MS + releaseBudgets.CLOCK_RESTORE_TIMEOUT_MS;
  const worst = getSessionReleaseCleanupWorstCaseMs(undefined, { clock });
  const release = h.manager.releaseSession("old", "plan-auto-release");
  await flush();
  expect(signal).toBeDefined();
  expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(worst);
  expect(h.manager.getReleaseStuckAtMs("old")).toBe(start + budget);
  await h.timer.advanceTimeAsync(releaseBudgets.CLOCK_RESTORE_TIMEOUT_MS - 1, flush);
  expect(signal?.aborted).toBe(false);
  restored.resolve();
  await flush();
  expect(session.cacheData.clock).toBeUndefined();
  expect(write).toHaveBeenCalledTimes(1);
  expect(h.manager.getReleaseStuckAtMs("old")).toBe(start + budget);
  expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(
    worst - (h.timer.now() - start),
  );
  await h.timer.advanceTimeAsync(
    start + releaseBudgets.SESSION_RELEASE_STUCK_DEADLINE_MS - h.timer.now(),
    flush,
  );
  await monitor.tick();
  expect(force).not.toHaveBeenCalled();
  expect(signal?.aborted).toBe(false);
  row.resolve();
  expect(await release).toBe(android.deviceId);
  expect(h.manager.getReleaseStuckAtMs("old")).toBeUndefined();
});

test("an ownership hold anchors the stuck deadline to its cap then its settlement", async () => {
  const persistence = new FakeDeviceSessionPersistence();
  const h = harness(persistence);
  await h.manager.createSession("old", android.deviceId, "android");
  const hold = Promise.withResolvers<"teardown">();
  const capMs = releaseBudgets.SESSION_RELEASE_STUCK_DEADLINE_MS + 1_000;
  h.manager.setReleaseDeviceHold(() => ({ settled: hold.promise, capMs }));
  const row = Promise.withResolvers<void>();
  const write = spyOn(persistence, "markReleased").mockImplementation(() => row.promise);
  const force = spyOn(h.manager, "forceStuckRelease");
  dispose.push(() => {
    write.mockRestore();
    force.mockRestore();
  });
  const monitor = new SessionHeartbeatMonitor(
    h.manager,
    () => false,
    async () => {},
    h.timer,
    {
      forceStuckRelease: (id) => forceStuckSessionRelease(h.manager, h.pool, id),
    },
  );
  monitor.start();
  dispose.push(() => {
    void monitor.stop();
  });
  const start = h.timer.now();
  const deadline = releaseBudgets.SESSION_RELEASE_STUCK_DEADLINE_MS;
  const release = h.manager.releaseSession("old", "plan-auto-release");
  await flush();
  expect(h.manager.getReleaseStuckAtMs("old")).toBe(start + capMs + deadline);
  expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(
    capMs + getSessionReleaseCleanupWorstCaseMs(),
  );
  await h.timer.advanceTimeAsync(deadline, flush);
  await monitor.tick();
  expect(force).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  const holdSettledAt = h.timer.now();
  hold.resolve("teardown");
  await flush();
  expect(h.manager.getReleaseStuckAtMs("old")).toBe(holdSettledAt + deadline);
  expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(
    getSessionReleaseCleanupWorstCaseMs(),
  );
  row.resolve();
  expect(await release).toBe(android.deviceId);
  expect(h.manager.getReleaseStuckAtMs("old")).toBeUndefined();
});

test("a forced release no longer reports a stuck deadline", async () => {
  const h = harness();
  await h.manager.createSession("old", android.deviceId, "android");
  const hold = Promise.withResolvers<"teardown">();
  h.manager.setReleaseDeviceHold(() => ({ settled: hold.promise, capMs: cap }));
  const release = h.manager.releaseSession("old", "plan-auto-release");
  await flush();
  expect(h.manager.getReleaseStuckAtMs("old")).toBeDefined();
  expect(h.manager.forceStuckRelease("old")).toBeDefined();
  expect(h.manager.getReleaseStuckAtMs("old")).toBeUndefined();
  hold.resolve("teardown");
  await release;
  expect(h.manager.getReleaseStuckAtMs("old")).toBeUndefined();
});

async function bounded(h: Harness, deviceId: string, name: string, leftover: string) {
  expect(h.manager.getDeviceCleanupRetryAfterMs(deviceId)).toBe(cap);
  expect(() => h.pool.assertDeviceCleanupComplete(deviceId)).toThrow(DeviceCleanupInProgressError);
  try {
    h.pool.assertDeviceCleanupComplete(deviceId);
  } catch (error) {
    expect(error).toBeInstanceOf(DeviceCleanupInProgressError);
    expect((error as DeviceCleanupInProgressError).retryAfterMs).toBe(cap);
  }
  await h.timer.advanceTimeAsync(cap - 1, flush);
  expect(() => h.pool.assertDeviceCleanupComplete(deviceId)).toThrow(DeviceCleanupInProgressError);
  expect(h.warn).not.toHaveBeenCalled();
  await h.timer.advanceTimeAsync(1, flush);
  expect(h.manager.hasDeviceCleanupInProgress(deviceId)).toBe(false);
  expect(() => h.pool.assertDeviceCleanupComplete(deviceId)).not.toThrow();
  expect(h.warn).toHaveBeenCalledTimes(1);
  const warning = String(h.warn.mock.calls[0][0]);
  for (const text of [name, deviceId, String(cap), leftover]) {
    expect(warning).toContain(text);
  }
}

test("release network push has a truthful bound and a single abandonment warning", async () => {
  const h = harness();
  const state = new NetworkState({ timer: h.timer, notifier: { notifyResourceUpdated: () => {} } });
  registerNetworkStateSessionCleanup(h.manager, {
    state: () => state,
    pusher: { push: () => new Promise<void>(() => {}) },
  });
  await h.manager.createSession("old", android.deviceId, "android");
  state.addMock(
    android.deviceId,
    {
      host: "example.com",
      path: "/",
      method: "*",
      limit: null,
      statusCode: 500,
      responseHeaders: {},
      responseBody: "",
      contentType: "text/plain",
    },
    "old",
  );
  await h.manager.releaseSession("old");
  await bounded(
    h,
    android.deviceId,
    "push cleared network state",
    "the released session's network mock rules and error simulation",
  );
});

test("bound-less registration keeps the default hint and quarantine past 10 seconds", async () => {
  const h = harness();
  const raw = Promise.withResolvers<void>();
  h.manager.registerPendingDeviceCleanup(device.deviceId, raw.promise);
  expect(h.manager.getDeviceCleanupRetryAfterMs(device.deviceId)).toBe(1_000);
  await h.timer.advanceTimeAsync(cap + 1, flush);
  expect(h.manager.getDeviceCleanupRetryAfterMs(device.deviceId)).toBe(1_000);
  expect(() => h.pool.assertDeviceCleanupComplete(device.deviceId)).toThrow(
    DeviceCleanupInProgressError,
  );
  expect(h.warn).not.toHaveBeenCalled();
  raw.resolve();
  await flush();
  expect(h.manager.hasDeviceCleanupInProgress(device.deviceId)).toBe(false);
});

for (const late of [false, true]) {
  test(`${late ? "late-set" : "release"} mock-location clear stops dispatching at the cap`, async () => {
    const h = harness();
    let calls = 0;
    let signal: AbortSignal | undefined;
    let hung = true;
    const clears = new MockLocationClearRegistry({
      timer: h.timer,
      simctlFactory: () => ({
        executeCommandArgs: (_args, _timeout, abort) => {
          calls++;
          signal = abort;
          return hung ? new Promise<string>(() => {}) : Promise.resolve("");
        },
      }),
    });
    registerLocationRouteSessionCleanup(h.manager, {
      registry: new LocationRouteRegistry(h.timer),
      mockLocationClears: clears,
    });
    await h.manager.createSession("old", device.deviceId, "ios");
    const applied = createSessionLocationAppliedCallback({
      sessionManager: h.manager,
      sessionUuid: "old",
      device,
      mockLocationClears: clears,
    });
    if (!late) {
      clears.markSet("old", device);
    }
    await h.manager.releaseSession("old");
    if (late) {
      applied!();
    }
    await flush();
    expect(h.manager.getDeviceCleanupRetryAfterMs(device.deviceId)).toBe(cap);
    expect(() => h.pool.assertDeviceCleanupComplete(device.deviceId)).toThrow(
      DeviceCleanupInProgressError,
    );
    try {
      h.pool.assertDeviceCleanupComplete(device.deviceId);
    } catch (error) {
      expect(error).toBeInstanceOf(DeviceCleanupInProgressError);
      expect((error as DeviceCleanupInProgressError).retryAfterMs).toBe(cap);
    }
    // Keep the first attempt parked until just before abandonment; its own 5s
    // attempt timer would otherwise warn about failure independently of the cap.
    h.timer.advanceTime(cap - 1);
    expect(h.manager.getDeviceCleanupRetryAfterMs(device.deviceId)).toBe(1);
    expect(() => h.pool.assertDeviceCleanupComplete(device.deviceId)).toThrow(
      DeviceCleanupInProgressError,
    );
    expect(h.warn).not.toHaveBeenCalled();
    h.timer.advanceTime(1);
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(h.manager.hasDeviceCleanupInProgress(device.deviceId)).toBe(false);
    expect(() => h.pool.assertDeviceCleanupComplete(device.deviceId)).not.toThrow();
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(String(h.warn.mock.calls[0][0])).toContain("clear mock location");
    expect(String(h.warn.mock.calls[0][0])).toContain(device.deviceId);
    expect(String(h.warn.mock.calls[0][0])).toContain(String(cap));
    expect(String(h.warn.mock.calls[0][0])).toContain("the released session's simulated location");
    const abandonedCalls = calls;
    await h.timer.advanceTimeAsync(cap, flush);
    expect(calls).toBe(abandonedCalls);
    expect(h.warn).toHaveBeenCalledTimes(1);
    hung = false;
    await h.manager.createSession("next", device.deviceId, "ios");
    clears.markSet("next", device);
    await h.manager.releaseSession("next");
    await flush();
    expect(calls).toBe(abandonedCalls + 1);
    expect(h.manager.hasDeviceCleanupInProgress(device.deviceId)).toBe(false);
  });
}

test("a descriptor cap waits for the live holder and starts at release", async () => {
  const h = harness();
  await h.manager.createSession("old", device.deviceId, "ios");
  h.manager.registerPendingDeviceCleanup(device.deviceId, new Promise<void>(() => {}), {
    name: "holder cleanup",
    leftover: "simulated state",
  });
  await h.timer.advanceTimeAsync(cap * 2, flush);
  expect(h.manager.hasDeviceCleanupInProgress(device.deviceId)).toBe(true);
  expect(h.manager.getDeviceCleanupRetryAfterMs(device.deviceId)).toBe(cap);
  expect(h.warn).not.toHaveBeenCalled();
  await h.manager.releaseSession("old");
  await bounded(h, device.deviceId, "holder cleanup", "simulated state");
});

for (const acquisition of [false, true]) {
  for (const shortFirst of [false, true]) {
    test(`${acquisition ? "acquisition" : "pending"} drops each settled bound (${shortFirst ? "short" : "long"} settles first)`, async () => {
      const h = harness();
      const first = Promise.withResolvers<void>();
      const second = Promise.withResolvers<void>();
      const register = acquisition
        ? h.manager.registerAcquisitionDeviceCleanup.bind(h.manager)
        : h.manager.registerPendingDeviceCleanup.bind(h.manager);
      register(device.deviceId, first.promise, shortFirst ? 5_000 : 60_000);
      // Acquisition work retains its own numeric cap; only pending listeners are manager capped.
      register(
        device.deviceId,
        second.promise,
        shortFirst ? 60_000 : acquisition ? cap : { name: "second cleanup", leftover: "state" },
      );
      await h.timer.advanceTimeAsync(1_000, flush);
      first.resolve();
      await flush();
      expect(h.manager.getDeviceCleanupRetryAfterMs(device.deviceId)).toBe(
        shortFirst ? 59_000 : 9_000,
      );
      await h.timer.advanceTimeAsync(4_000, flush);
      expect(h.manager.getDeviceCleanupRetryAfterMs(device.deviceId)).toBe(
        shortFirst ? 55_000 : 5_000,
      );
      second.resolve();
      await flush();
      expect(h.manager.hasDeviceCleanupInProgress(device.deviceId)).toBe(false);
    });
  }
}

test("throwing abandonment still frees the device", async () => {
  const h = harness();
  h.manager.registerPendingDeviceCleanup(device.deviceId, new Promise<void>(() => {}), {
    name: "broken cleanup",
    leftover: "dirty state",
    abandon: () => {
      throw new Error("broken fence");
    },
  });
  await h.timer.advanceTimeAsync(cap, flush);
  expect(h.manager.hasDeviceCleanupInProgress(device.deviceId)).toBe(false);
  expect(h.warn).toHaveBeenCalledTimes(2); // Fence failure and the single abandonment warning.
});

for (const reason of [undefined, "heartbeat-timeout"] as const) {
  test(`a late set during the same session's ${reason ?? "default"} release gets a manager-capped clear`, async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const gate = Promise.withResolvers<void>();
    const h = harness(persistence);
    const session = await h.manager.createSession("old", device.deviceId, "ios");
    const commands: string[][] = [];
    let signal: AbortSignal | undefined;
    const clears = new MockLocationClearRegistry({
      timer: h.timer,
      simctlFactory: () => ({
        executeCommandArgs: (args, _timeout, abort) => {
          commands.push(args);
          signal = abort;
          return new Promise<string>(() => {});
        },
      }),
    });
    const applied = createSessionLocationAppliedCallback({
      sessionManager: h.manager,
      sessionUuid: "old",
      device,
      mockLocationClears: clears,
    });
    const write = spyOn(persistence, "markReleased").mockImplementation(() => gate.promise);
    const register = spyOn(h.manager, "registerPendingDeviceCleanup");
    dispose.push(() => {
      write.mockRestore();
      register.mockRestore();
    });
    const release = h.manager.releaseSession("old", reason);
    await flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(h.manager.getSessionForDevice(device.deviceId)).toBe("old");
    expect(h.manager.peekSession("old")).toBeNull();
    expect(h.manager.getReleasingSession("old")).toBe(session);
    applied!();
    await flush();
    expect(commands).toEqual([["location", device.deviceId, "clear"]]);
    expect(h.warn).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith(device.deviceId, expect.any(Promise), {
      name: "clear mock location",
      leftover: "the released session's simulated location",
      abandon: expect.any(Function),
    });
    expect(h.manager.getPendingDeviceCleanup(device.deviceId)).not.toBeNull();
    gate.resolve();
    await release;
    expect(h.manager.getDeviceCleanupRetryAfterMs(device.deviceId)).toBe(cap);
    // One turn reaches abandonment before the hung attempt's rejection can schedule a retry.
    h.timer.advanceTime(cap);
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(h.manager.hasDeviceCleanupInProgress(device.deviceId)).toBe(false);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(String(h.warn.mock.calls[0][0])).toContain("clear mock location");
    expect(String(h.warn.mock.calls[0][0])).not.toContain("now held by");
  });
}

for (const holderId of ["old", "next"]) {
  test(`location holder accessors identify the ${holderId === "old" ? "same" : "different"}-UUID replacement object`, async () => {
    const h = harness();
    const old = await h.manager.createSession("old", device.deviceId, "ios");
    await h.manager.releaseSession("old", "plan-auto-release");
    const holder = await h.manager.createSession(holderId, device.deviceId, "ios");
    expect(holder).not.toBe(old);
    expect(h.manager.getSessionForDevice(device.deviceId)).toBe(holderId);
    expect(h.manager.peekSession(holderId)).toBe(holder);
    expect(h.manager.getReleasingSession(holderId)).toBeNull();
  });
}

for (const marked of [false, true]) {
  test(`a late set on a new holder ${marked ? "preserves" : "creates"} its marker until release`, async () => {
    const h = harness();
    let calls = 0;
    const clears = new MockLocationClearRegistry({
      timer: h.timer,
      simctlFactory: () => ({
        executeCommandArgs: async () => {
          calls++;
          return "";
        },
      }),
    });
    registerLocationRouteSessionCleanup(h.manager, {
      registry: new LocationRouteRegistry(h.timer),
      mockLocationClears: clears,
    });
    await h.manager.createSession("old", device.deviceId, "ios");
    const applied = createSessionLocationAppliedCallback({
      sessionManager: h.manager,
      sessionUuid: "old",
      device,
      mockLocationClears: clears,
    });
    await h.manager.releaseSession("old");
    await h.manager.createSession("next", device.deviceId, "ios");
    if (marked) {
      clears.markSet("next", device);
    }
    applied!();
    await flush();
    expect(calls).toBe(0);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(String(h.warn.mock.calls[0][0])).toContain("next");
    clears.abandonClear("old", device.deviceId);
    expect(clears.clearAfter("old", device.deviceId, Promise.resolve())).toBeNull();
    await h.manager.releaseSession("next");
    await flush();
    expect(calls).toBe(1);
  });
}

test("a late set from a same-UUID replacement's old object preserves the held marker", async () => {
  const h = harness();
  const commands: string[][] = [];
  const clears = new MockLocationClearRegistry({
    timer: h.timer,
    simctlFactory: () => ({
      executeCommandArgs: async (args) => {
        commands.push(args);
        return "";
      },
    }),
  });
  registerLocationRouteSessionCleanup(h.manager, {
    registry: new LocationRouteRegistry(h.timer),
    mockLocationClears: clears,
  });
  const old = await h.manager.createSession("old", device.deviceId, "ios");
  const applied = createSessionLocationAppliedCallback({
    sessionManager: h.manager,
    sessionUuid: "old",
    device,
    mockLocationClears: clears,
  });
  await h.manager.releaseSession("old", "plan-auto-release");
  const replacement = await h.manager.createSession("old", device.deviceId, "ios");
  expect(replacement).not.toBe(old);
  clears.markSet("old", device);
  applied!();
  await flush();
  expect(h.manager.getSessionForDevice(device.deviceId)).toBe("old");
  expect(commands).toEqual([]);
  expect(h.warn).toHaveBeenCalledTimes(1);
  expect(String(h.warn.mock.calls[0][0])).toContain("now held by old");
  await h.manager.releaseSession("old");
  await flush();
  // Only the replacement's release consumes the surviving marker.
  expect(commands).toEqual([["location", device.deviceId, "clear"]]);
});

for (const interval of [3_000, 7_000]) {
  test(`a joined monitor reap meets the advertised release bound at ${interval}ms cadence`, async () => {
    const key = "AUTOMOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS";
    const previous = process.env[key];
    dispose.push(() => {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    });
    process.env[key] = String(interval);
    class ParkedPersistence extends FakeDeviceSessionPersistence {
      gate: Promise<void> | undefined;
      override async upsertActiveSession(record: DeviceSessionRecord) {
        await this.gate;
        await super.upsertActiveSession(record);
      }
    }
    const persistence = new ParkedPersistence();
    const h = harness(persistence);
    await h.manager.createSession("old", android.deviceId, "android");
    // No owner heartbeat arrives. It is already stale when the release starts.
    await h.timer.advanceTimeAsync(90_000, flush);
    persistence.gate = new Promise<void>(() => {});
    void h.manager.rebindSession("old", "emulator-5556", "android");
    await flush();
    let reaps = 0;
    const monitor = new SessionHeartbeatMonitor(
      h.manager,
      () => false,
      async (id, reason) => {
        reaps++;
        await h.manager.releaseSession(id, reason);
      },
      h.timer,
      { forceStuckRelease: (id) => forceStuckSessionRelease(h.manager, h.pool, id) },
    );
    const scanOrigin = h.timer.now();
    monitor.start();
    dispose.push(() => {
      void monitor.stop();
    });
    expect(h.timer.getPendingIntervals()).toContain(interval);
    await h.timer.advanceTimeAsync(1, flush);
    const startedAt = h.timer.now();
    void h.manager.releaseSession("old", "plan-auto-release");
    await flush();
    expect(h.manager.getSessionForDevice(android.deviceId)).toBe("old");
    expect(h.manager.peekSession("old")).toBe(h.manager.getReleasingSession("old"));
    expect(h.manager.peekSession("old")).not.toBeNull();
    const worst = getSessionReleaseCleanupWorstCaseMs();
    expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(worst);
    expect(() => h.pool.assertDeviceCleanupComplete(android.deviceId)).toThrow(
      DeviceCleanupInProgressError,
    );
    let freedAt: number | undefined;
    const observe = async () => {
      await flush();
      if (freedAt === undefined && !h.manager.hasDeviceCleanupInProgress(android.deviceId)) {
        freedAt = h.timer.now();
      }
    };
    const lastScanBeforeDeadline =
      scanOrigin +
      (Math.ceil((startedAt + STUCK_REAP_WARN_MS - scanOrigin) / interval) - 1) * interval;
    await h.timer.advanceTimeAsync(lastScanBeforeDeadline - h.timer.now(), observe);
    expect(h.manager.getSessionForDevice(android.deviceId)).toBe("old");
    expect(freedAt).toBeUndefined();
    expect(h.manager.getReleaseStuckAtMs("old")).toBe(startedAt + STUCK_REAP_WARN_MS);
    await h.timer.advanceTimeAsync(startedAt + worst - 1 - h.timer.now(), observe);
    expect(reaps).toBe(1); // The monitor really joined the parked release.
    if (h.manager.hasDeviceCleanupInProgress(android.deviceId)) {
      expect(() => h.pool.assertDeviceCleanupComplete(android.deviceId)).toThrow(
        DeviceCleanupInProgressError,
      );
    } else {
      expect(() => h.pool.assertDeviceCleanupComplete(android.deviceId)).not.toThrow();
    }
    await h.timer.advanceTimeAsync(1, observe);
    expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(false);
    expect(() => h.pool.assertDeviceCleanupComplete(android.deviceId)).not.toThrow();
    // Joining keeps the source deadline: force at the first scan on/after that deadline.
    const forcedAt =
      scanOrigin + Math.ceil((startedAt + STUCK_REAP_WARN_MS - scanOrigin) / interval) * interval;
    expect(freedAt).toBe(forcedAt + cap);
    expect(freedAt!).toBeLessThanOrEqual(startedAt + worst);
  });
}

test("a monitor reap joining after an execution veto still meets the advertised release bound", async () => {
  // The scans are synchronous; only the parked release's promise chain needs draining between ticks.
  const step = () => drainMicrotasks(20);
  class ParkedPersistence extends FakeDeviceSessionPersistence {
    gate: Promise<void> | undefined;
    override async upsertActiveSession(record: DeviceSessionRecord) {
      await this.gate;
      await super.upsertActiveSession(record);
    }
  }
  const persistence = new ParkedPersistence();
  const h = harness(persistence);
  await h.manager.createSession("old", android.deviceId, "android", 600_000);
  await h.timer.advanceTimeAsync(90_000, step);
  persistence.gate = new Promise<void>(() => {});
  void h.manager.rebindSession("old", "emulator-5556", "android");
  await step();
  const startedAt = h.timer.now();
  const tracker = new ExecutionTracker(h.timer, new FakeIdGenerator(["hung-call"]));
  const execution = tracker.startExecution("tapOn", undefined, "old");
  const joinAfterMs =
    releaseBudgets.SESSION_RELEASE_STUCK_DEADLINE_MS - getSessionHeartbeatCheckIntervalMs();
  tracker.setExecutionDeadline(
    execution.id,
    () => startedAt + joinAfterMs - UNSETTLED_EXECUTION_DEADLINE_GRACE_MS,
  );
  const hasActiveExecutions = (id: string) => tracker.hasActiveSessionUuidExecutions(id);
  h.manager.setActiveSessionExecutionChecker(hasActiveExecutions);
  void h.manager.releaseSession("old", "plan-auto-release");
  await step();
  expect(h.manager.isReleaseInProgress("old", startedAt)).toBe(true);
  let reaps = 0;
  let joinedAt: number | undefined;
  const monitor = new SessionHeartbeatMonitor(
    h.manager,
    {
      hasActiveExecutions,
      latestExecutionDeadlineMs: (id) => tracker.getLatestSessionExecutionDeadlineMs(id),
    },
    async (id, reason) => {
      reaps++;
      joinedAt = h.timer.now();
      await h.manager.releaseSession(id, reason);
    },
    h.timer,
    { forceStuckRelease: (id) => forceStuckSessionRelease(h.manager, h.pool, id) },
  );
  monitor.start();
  dispose.push(() => {
    tracker.endExecution(execution.id);
    void monitor.stop();
  });
  const interval = getSessionHeartbeatCheckIntervalMs();
  await h.timer.advanceTimeAsync(joinAfterMs - interval, step);
  expect(reaps).toBe(0);
  await h.timer.advanceTimeAsync(interval, step);
  expect(reaps).toBe(1);
  expect(joinedAt).toBe(startedAt + joinAfterMs);
  const worst = getSessionReleaseCleanupWorstCaseMs();
  await h.timer.advanceTimeAsync(startedAt + worst - h.timer.now(), step);
  expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(false);
  expect(() => h.pool.assertDeviceCleanupComplete(android.deviceId)).not.toThrow();
});

test("a monitor-tracked wedged release advertises the whole forced-release worst case", async () => {
  class ParkedPersistence extends FakeDeviceSessionPersistence {
    gate: Promise<void> | undefined;
    override async upsertActiveSession(record: DeviceSessionRecord) {
      await this.gate;
      await super.upsertActiveSession(record);
    }
  }
  const persistence = new ParkedPersistence();
  const h = harness(persistence);
  await h.manager.createSession("old", android.deviceId, "android");
  persistence.gate = new Promise<void>(() => {});
  void h.manager.rebindSession("old", "emulator-5556", "android");
  await flush();
  void h.manager.releaseSession("old", "plan-auto-release");
  await flush();
  const monitor = new SessionHeartbeatMonitor(
    h.manager,
    () => false,
    async (id, reason) => {
      await h.manager.releaseSession(id, reason);
    },
    h.timer,
    {
      forceStuckRelease: (id) => forceStuckSessionRelease(h.manager, h.pool, id),
    },
  );
  dispose.push(() => {
    void monitor.stop();
  });
  const interval = getSessionHeartbeatCheckIntervalMs();
  expect(interval).toBe(DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS);
  const worst = getSessionReleaseCleanupWorstCaseMs();
  expect(worst).toBe(STUCK_REAP_WARN_MS + 2 * interval + cap);
  expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(worst);
  expect(() => h.pool.assertDeviceCleanupComplete(android.deviceId)).toThrow(
    DeviceCleanupInProgressError,
  );
  await h.timer.advanceTimeAsync(15_000, flush);
  expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(worst - 15_000);
  await monitor.tick();
  // Exercise the inclusive upper endpoint of the next-scan allowance. The real
  // scan, not a hand-triggered force, must start the 10s quarantine at this point.
  await h.timer.advanceTimeAsync(STUCK_REAP_WARN_MS + interval - 15_000, flush);
  await monitor.tick();
  await flush();
  expect(h.manager.getSessionForDevice(android.deviceId)).toBeNull();
  expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(cap);
  await h.timer.advanceTimeAsync(cap - 1, flush);
  expect(() => h.pool.assertDeviceCleanupComplete(android.deviceId)).toThrow(
    DeviceCleanupInProgressError,
  );
  await h.timer.advanceTimeAsync(1, flush);
  expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(false);
  expect(() => h.pool.assertDeviceCleanupComplete(android.deviceId)).not.toThrow();
});

test("abandoned descriptor absorbs a late rejection without another warning", async () => {
  const h = harness();
  const raw = Promise.withResolvers<void>();
  let abandoned = false;
  h.manager.registerPendingDeviceCleanup(device.deviceId, raw.promise, {
    name: "late failure cleanup",
    leftover: "unfinished state",
    abandon: () => {
      abandoned = true;
    },
  });
  await bounded(h, device.deviceId, "late failure cleanup", "unfinished state");
  expect(abandoned).toBe(true);
  raw.reject(new Error("late failure"));
  await flush();
  expect(h.warn).toHaveBeenCalledTimes(1);
});

test("numeric pending bounds remain trusted and retain the deferred gate's raw identity", async () => {
  const h = harness();
  const ownGate = Promise.withResolvers<void>();
  h.manager.registerPendingDeviceCleanup(device.deviceId, ownGate.promise, cap);
  expect(h.manager.getPendingDeviceCleanup(device.deviceId, ownGate.promise)).toBeNull();
  const other = Promise.withResolvers<void>();
  h.manager.registerPendingDeviceCleanup(device.deviceId, other.promise);
  const joined = h.manager.getPendingDeviceCleanup(device.deviceId, ownGate.promise);
  expect(joined).not.toBeNull();
  other.resolve();
  await joined;
  await h.timer.advanceTimeAsync(cap + 1, flush);
  expect(h.manager.hasDeviceCleanupInProgress(device.deviceId)).toBe(true);
  expect(h.manager.getDeviceCleanupRetryAfterMs(device.deviceId)).toBe(1_000);
  expect(h.warn).not.toHaveBeenCalled();
  ownGate.resolve();
  await flush();
  expect(h.manager.hasDeviceCleanupInProgress(device.deviceId)).toBe(false);
});

test("internal hung setup transfer stays uncapped with the default polling hint", async () => {
  const h = harness();
  const session = await h.manager.createSession("old", android.deviceId, "android");
  const gate = Promise.withResolvers<void>();
  const setup = h.manager.trackSessionSetup(session, () => gate.promise);
  await flush();
  const release = h.manager.releaseSession("old", "released", true);
  await flush();
  await h.timer.advanceTimeAsync(1_000, flush);
  await release;
  expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(1_000);
  await h.timer.advanceTimeAsync(cap + 1, flush);
  expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(true);
  expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(1_000);
  expect(() => h.pool.assertDeviceCleanupComplete(android.deviceId)).toThrow(
    DeviceCleanupInProgressError,
  );
  gate.resolve();
  await setup;
  await flush();
  expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(false);
});

test("the env-resolved monitor interval is shared by the manager release bound", async () => {
  const key = "AUTOMOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS";
  const previous = process.env[key];
  dispose.push(() => {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  });
  process.env[key] = "7000";
  expect(getSessionHeartbeatCheckIntervalMs()).toBe(7_000);
  class ParkedPersistence extends FakeDeviceSessionPersistence {
    gate: Promise<void> | undefined;
    override async upsertActiveSession(record: DeviceSessionRecord) {
      await this.gate;
      await super.upsertActiveSession(record);
    }
  }
  const persistence = new ParkedPersistence();
  const h = harness(persistence);
  await h.manager.createSession("old", android.deviceId, "android");
  persistence.gate = new Promise<void>(() => {});
  void h.manager.rebindSession("old", "emulator-5556", "android");
  await flush();
  void h.manager.releaseSession("old", "plan-auto-release");
  await flush();
  const monitor = new SessionHeartbeatMonitor(
    h.manager,
    () => false,
    async () => {},
    h.timer,
  );
  monitor.start();
  dispose.push(() => {
    void monitor.stop();
  });
  expect(h.timer.getPendingIntervals()).toContain(7_000);
  // The manager resolves the env when reading a hint; daemon construction uses
  // this same resolver for the monitor's default configuration.
  expect(getSessionReleaseCleanupWorstCaseMs()).toBe(STUCK_REAP_WARN_MS + 2 * 7_000 + cap);
  expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(
    getSessionReleaseCleanupWorstCaseMs(),
  );
});

test("an explicit release with a live owner meets the advertised cleanup bound without a reap", async () => {
  const step = () => drainMicrotasks(20);
  class ParkedPersistence extends FakeDeviceSessionPersistence {
    gate: Promise<void> | undefined;
    override async upsertActiveSession(record: DeviceSessionRecord) {
      await this.gate;
      await super.upsertActiveSession(record);
    }
  }
  const persistence = new ParkedPersistence();
  const h = harness(persistence);
  h.deviceManager.setBootedDevices("android", [android]);
  await h.pool.initializeWithDevices([android]);
  const session = await h.manager.createSession(
    "old",
    android.deviceId,
    "android",
    600_000,
    600_000,
  );
  expect(await h.manager.claimLivenessOwnership("old", "live-owner")).toBe("claimed");
  persistence.gate = new Promise<void>(() => {});
  void h.manager.rebindSession("old", "emulator-5556", "android");
  await step();
  const force = spyOn(h.manager, "forceStuckRelease");
  dispose.push(() => force.mockRestore());
  const forcedAt: number[] = [];
  let reaps = 0;
  const monitor = new SessionHeartbeatMonitor(
    h.manager,
    () => false,
    async (id, reason) => {
      reaps++;
      await h.manager.releaseSession(id, reason);
    },
    h.timer,
    {
      forceStuckRelease: async (id) => {
        forcedAt.push(h.timer.now());
        await forceStuckSessionRelease(h.manager, h.pool, id);
      },
    },
  );
  const scanOrigin = h.timer.now();
  monitor.start();
  dispose.push(() => void monitor.stop());
  await h.timer.advanceTimeAsync(1, step);
  const startedAt = h.timer.now();
  void h.manager.releaseSession("old", "explicit-release");
  await step();
  const worst = getSessionReleaseCleanupWorstCaseMs();
  const stuckAt = h.manager.getReleaseStuckAtMs("old")!;
  const interval = getSessionHeartbeatCheckIntervalMs();
  const dueScan = scanOrigin + Math.ceil((stuckAt - scanOrigin) / interval) * interval;
  expect(stuckAt).toBe(startedAt + STUCK_REAP_WARN_MS);
  expect(session.heartbeatTimeoutMs).toBeGreaterThan(worst);
  expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(worst);
  await expect(
    h.pool.bindOrReuseDeviceSession("next", android.deviceId, "android"),
  ).rejects.toBeInstanceOf(DeviceCleanupInProgressError);
  await h.timer.advanceTimeAsync(dueScan - 1 - h.timer.now(), step);
  expect(force).not.toHaveBeenCalled();
  expect(() => h.pool.assertDeviceCleanupComplete(android.deviceId)).toThrow(
    DeviceCleanupInProgressError,
  );
  await h.timer.advanceTimeAsync(1, step);
  expect(forcedAt).toEqual([dueScan]);
  expect(force).toHaveBeenCalledTimes(1);
  expect(h.manager.getSession("old")).toBeNull();
  expect(h.manager.getSessionForDevice(android.deviceId)).toBeNull();
  expect(h.manager.getTerminalReleaseSnapshot("old")?.releaseReason).toBe("explicit-release");
  await h.timer.advanceTimeAsync(cap - 1, step);
  await expect(
    h.pool.bindOrReuseDeviceSession("next", android.deviceId, "android"),
  ).rejects.toBeInstanceOf(DeviceCleanupInProgressError);
  await h.timer.advanceTimeAsync(1, step);
  expect(h.manager.hasDeviceCleanupInProgress(android.deviceId)).toBe(false);
  expect(h.timer.now()).toBeLessThanOrEqual(startedAt + worst);
  // Only the replacement row write is unparked; the old rebind remains wedged.
  persistence.gate = undefined;
  expect(await h.pool.bindOrReuseDeviceSession("next", android.deviceId, "android")).toBe("next");
  await h.timer.advanceTimeAsync(2 * interval, step);
  expect(reaps).toBe(0);
  expect(force).toHaveBeenCalledTimes(1);
  expect(h.manager.getSession("old")).toBeNull();
  expect(h.manager.getTerminalReleaseSnapshot("old")?.releaseReason).toBe("explicit-release");
});

test("late screen-reader setup grows the stuck budget before its first restore", async () => {
  const restored = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const h = harness(undefined, {
    screenReader: () => ({
      restore: async (_state, abort) => {
        signal = abort;
        await restored.promise;
      },
    }),
  });
  const session = await h.manager.createSession(
    "late",
    android.deviceId,
    "android",
    600_000,
    600_000,
  );
  const setupGate = Promise.withResolvers<void>();
  const setup = h.manager.trackScreenReaderSessionSetup(session, async () => {
    await setupGate.promise;
    h.manager.setScreenReader(session, { platform: "android", previousEnabled: false });
  });
  const force = spyOn(h.manager, "forceStuckRelease");
  dispose.push(() => force.mockRestore());
  const monitor = new SessionHeartbeatMonitor(
    h.manager,
    () => false,
    async () => {},
    h.timer,
    {
      forceStuckRelease: (id) => forceStuckSessionRelease(h.manager, h.pool, id),
    },
  );
  monitor.start();
  dispose.push(() => void monitor.stop());
  const start = h.timer.now();
  const release = h.manager.releaseSession("late", "explicit-release");
  await flush();
  expect(h.manager.getReleaseStuckAtMs("late")).toBe(
    start + releaseBudgets.SESSION_RELEASE_STUCK_DEADLINE_MS,
  );
  await h.timer.advanceTimeAsync(500, flush);
  setupGate.resolve();
  await setup;
  await flush();
  expect(h.manager.getReleaseStuckAtMs("late")).toBe(
    start + releaseBudgets.SESSION_RELEASE_STUCK_DEADLINE_MS + SCREEN_READER_RESTORE_TIMEOUT_MS,
  );
  await h.timer.advanceTimeAsync(25_000, flush);
  expect(force).not.toHaveBeenCalled();
  expect(signal).toBeDefined();
  expect(signal?.aborted).toBe(false);
  restored.resolve();
  expect(await release).toBe(android.deviceId);
  expect(h.manager.getReleaseStuckAtMs("late")).toBeUndefined();
});

test("declined final commit fence cannot force a parked live-row rewrite", async () => {
  const persistence = new FakeDeviceSessionPersistence();
  const h = harness(persistence);
  const session = await h.manager.createSession(
    "kept",
    android.deviceId,
    "android",
    600_000,
    600_000,
  );
  const rewrite = Promise.withResolvers<void>();
  const upsert = spyOn(persistence, "upsertActiveSession").mockImplementation(
    () => rewrite.promise,
  );
  const force = spyOn(h.manager, "forceStuckRelease");
  dispose.push(() => {
    upsert.mockRestore();
    force.mockRestore();
  });
  const monitor = new SessionHeartbeatMonitor(
    h.manager,
    () => false,
    async () => {},
    h.timer,
    {
      forceStuckRelease: (id) => forceStuckSessionRelease(h.manager, h.pool, id),
    },
  );
  monitor.start();
  dispose.push(() => void monitor.stop());
  let checks = 0;
  const release = h.manager.releaseSessionUnlessSuperseded(
    "kept",
    `device-disconnected:${android.deviceId}`,
    () => ++checks < 2,
  );
  await flush();
  expect(checks).toBe(2);
  expect(upsert).toHaveBeenCalledTimes(1);
  expect(h.manager.getTerminalReleasesInProgress()).toEqual([]);
  expect(h.manager.getReleaseStuckAtMs("kept")).toBeUndefined();
  expect(h.manager.getDeviceCleanupRetryAfterMs(android.deviceId)).toBe(1_000);
  expect(h.manager.isReleaseInProgress("kept", h.timer.now())).toBe(true);
  await h.timer.advanceTimeAsync(25_000, flush);
  expect(force).not.toHaveBeenCalled();
  expect(h.manager.forceStuckRelease("kept")).toBeUndefined();
  expect(h.manager.getSession("kept")).toBe(session);
  expect(h.manager.getSessionForDevice(android.deviceId)).toBe("kept");
  rewrite.resolve();
  expect(await release).toEqual({ superseded: true });
  expect(h.manager.getTerminalReleaseSnapshot("kept")).toBeUndefined();
});

test("an undecided commit fence still forces wedged teardown at its deadline", async () => {
  const gate = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const h = harness(undefined, {
    screenReader: () => ({
      restore: async (_state, abort) => {
        signal = abort;
        await gate.promise;
      },
    }),
  });
  const session = await h.manager.createSession(
    "wedged-fence",
    android.deviceId,
    "android",
    600_000,
    600_000,
  );
  h.manager.setScreenReader(session, { platform: "android", previousEnabled: false });
  // Simulate a lost first-attempt timeout callback: the monitor's independent stuck timer
  // must still fence a release that has not reached either commit check.
  const scheduleFakeTimeout = h.timer.setTimeout.bind(h.timer);
  const timeout = spyOn(h.timer, "setTimeout").mockImplementation((callback, ms) =>
    scheduleFakeTimeout(ms === SCREEN_READER_RESTORE_TIMEOUT_MS ? () => {} : callback, ms),
  );
  const force = spyOn(h.manager, "forceStuckRelease");
  dispose.push(() => {
    gate.resolve();
    timeout.mockRestore();
    force.mockRestore();
  });
  const monitor = new SessionHeartbeatMonitor(
    h.manager,
    () => false,
    async () => {},
    h.timer,
    {
      forceStuckRelease: (id) => forceStuckSessionRelease(h.manager, h.pool, id),
    },
  );
  monitor.start();
  dispose.push(() => void monitor.stop());
  let fenceChecks = 0;
  const release = h.manager.releaseSessionUnlessSuperseded(
    "wedged-fence",
    `device-disconnected:${android.deviceId}`,
    () => {
      fenceChecks++;
      return true;
    },
  );
  await flush();
  const deadline = h.manager.getReleaseStuckAtMs("wedged-fence")!;
  await h.timer.advanceTimeAsync(deadline - 1 - h.timer.now(), flush);
  expect(force).not.toHaveBeenCalled();
  await h.timer.advanceTimeAsync(1, flush);
  await monitor.tick();
  expect(force).toHaveBeenCalledTimes(1);
  expect(fenceChecks).toBe(0);
  expect(signal?.aborted).toBe(true);
  expect(h.manager.getSessionForDevice(android.deviceId)).toBeNull();
  gate.resolve();
  await release;
});
