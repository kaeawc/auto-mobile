import { afterEach, expect, spyOn, test } from "bun:test";
import {
  SessionManager,
  SESSION_RELEASE_TEARDOWN_CAP_MS,
  getSessionReleaseCleanupWorstCaseMs,
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

function harness(persistence = new FakeDeviceSessionPersistence()) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000_000);
  const manager = new SessionManager(timer, persistence, () => new FakeDbWriteBarrier());
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "cleanup-bounds", {
      timer,
      deviceManager: new FakeDeviceUtils(),
    }),
  );
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  dispose.push(() => {
    manager.stopCleanupTimer();
    timer.reset();
    warn.mockRestore();
  });
  return { timer, manager, pool, warn };
}
type Harness = ReturnType<typeof harness>;
const flush = () => drainMicrotasks(100);

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
    await h.timer.advanceTimeAsync(worst - 1, observe);
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
  tracker.setExecutionDeadline(execution.id, () => startedAt + 20_000);
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
  await h.timer.advanceTimeAsync(30_000 - interval, step);
  expect(reaps).toBe(0);
  await h.timer.advanceTimeAsync(interval, step);
  expect(reaps).toBe(1);
  expect(joinedAt).toBe(startedAt + 30_000);
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
