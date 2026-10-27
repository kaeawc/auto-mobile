import { mock, afterEach, describe, expect, spyOn, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import type { DeviceAutolockManager } from "../../src/daemon/deviceAutolockManager";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

afterEach(() => {
  mock.restore();
});

describe("explicit rebind release caller ordering", () => {
  test.each([false, true])("pool rejection=%s keeps rebound session live", async (rejectPool) => {
    const timer = new FakeTimer();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    sessions.stopCleanupTimer();
    const events: unknown[][] = [];
    const devices = ["old", "new"].map((deviceId) => ({
      deviceId,
      name: deviceId,
      platform: "android" as const,
    }));
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "daemon", {
        env: { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" },
        timer,
        deviceManager: new FakeDeviceManager([], devices),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        ambientExecutionIdReader: { getExecutionId: () => "caller" },
        cancelDeviceSessionExecutions: Object.assign(async () => 0, {
          cancelDeviceExecutions: async (
            id: string,
            _reason: string | Error,
            options?: { onlySessionUuid?: string; excludeExecutionId?: string },
          ) => {
            events.push(["cancelOldDeviceWorkForRebind", id, options]);
            return 0;
          },
        }),
      }),
    );
    const restores: Array<() => void> = [];
    try {
      await pool.initializeWithDevices(devices);
      await pool.bindOrReuseDeviceSession({
        sessionId: "s1",
        deviceId: "old",
        platform: "android",
      });
      const rebind = sessions.rebindSession.bind(sessions);
      const rebound = spyOn(sessions, "rebindSession").mockImplementation(async (...args) => {
        events.push(["session.rebindSession", ...args]);
        return rebind(...args);
      });
      restores.push(() => rebound.mockRestore());
      // Observe the existing private collaborator without replacing the production bind flow.
      const autolock = pool.testHooks.autolockManager as DeviceAutolockManager;
      const clear = autolock.clearRebindAutolockLock.bind(autolock);
      const cleared = spyOn(autolock, "clearRebindAutolockLock").mockImplementation((...args) => {
        events.push(["autolock.clearRebindAutolockLock", ...args]);
        clear(...args);
      });
      restores.push(() => cleared.mockRestore());
      const failure = new Error("pool failed");
      const oldDevice = pool.getDevice("old")!;
      const freed = spyOn(pool, "releaseDevice").mockImplementation(async (...args) => {
        events.push(["pool.releaseDevice", ...args]);
        if (rejectPool) {
          throw failure;
        }
      });
      restores.push(() => freed.mockRestore());
      const binding = pool.bindOrReuseDeviceSession({
        sessionId: "s1",
        deviceId: "new",
        platform: "android",
        allowSessionRebind: true,
      });
      if (rejectPool) {
        await expect(binding).rejects.toBe(failure);
      } else {
        expect(await binding).toBe("s1");
      }
      expect(events).toEqual([
        [
          "session.rebindSession",
          "s1",
          "new",
          "android",
          { stableDeviceId: "new", deferCleanup: undefined },
        ],
        ["autolock.clearRebindAutolockLock", "s1", "old", oldDevice],
        [
          "cancelOldDeviceWorkForRebind",
          "old",
          { excludeExecutionId: "caller", onlySessionUuid: "s1" },
        ],
        ["pool.releaseDevice", "old", "s1"],
      ]);
      expect(sessions.hasSession("s1")).toBe(true);
      expect(sessions.getSession("s1")?.assignedDevice).toBe("new");
      // A client-chosen move is not a recovery: no generation, no previous serial (#15456).
      expect(sessions.getSession("s1")?.deviceGeneration).toBeUndefined();
    } finally {
      for (const restore of restores.reverse()) {
        restore();
      }
      pool.releaseDeviceClaimsForShutdown();
      sessions.stopCleanupTimer();
      timer.reset();
    }
  });

  test("a recovery bind rebinds with recovery set and counts one generation (#15456)", async () => {
    const timer = new FakeTimer();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    sessions.stopCleanupTimer();
    const events: unknown[][] = [];
    const devices = ["old", "new"].map((deviceId) => ({
      deviceId,
      name: deviceId,
      platform: "android" as const,
    }));
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "daemon", {
        env: { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" },
        timer,
        deviceManager: new FakeDeviceManager([], devices),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        ambientExecutionIdReader: { getExecutionId: () => "caller" },
        cancelDeviceSessionExecutions: Object.assign(async () => 0, {
          cancelDeviceExecutions: async (
            id: string,
            _reason: string | Error,
            options?: { onlySessionUuid?: string; excludeExecutionId?: string },
          ) => {
            events.push(["cancelOldDeviceWorkForRebind", id, options]);
            return 0;
          },
        }),
      }),
    );
    const restores: Array<() => void> = [];
    try {
      await pool.initializeWithDevices(devices);
      await pool.bindOrReuseDeviceSession({
        sessionId: "s1",
        deviceId: "old",
        platform: "android",
      });
      const rebind = sessions.rebindSession.bind(sessions);
      const rebound = spyOn(sessions, "rebindSession").mockImplementation(async (...args) => {
        events.push(["session.rebindSession", ...args]);
        return rebind(...args);
      });
      restores.push(() => rebound.mockRestore());
      // Observe the existing private collaborator without replacing the production bind flow.
      const autolock = pool.testHooks.autolockManager as DeviceAutolockManager;
      const clear = autolock.clearRebindAutolockLock.bind(autolock);
      const cleared = spyOn(autolock, "clearRebindAutolockLock").mockImplementation((...args) => {
        events.push(["autolock.clearRebindAutolockLock", ...args]);
        clear(...args);
      });
      restores.push(() => cleared.mockRestore());
      const freed = spyOn(pool, "releaseDevice").mockImplementation(async (...args) => {
        events.push(["pool.releaseDevice", ...args]);
      });
      restores.push(() => freed.mockRestore());
      const binding = pool.bindOrReuseDeviceSession({
        sessionId: "s1",
        deviceId: "new",
        platform: "android",
        allowSessionRebind: true,
        expectedExistingSessionDeviceId: "old",
      });
      expect(await binding).toBe("s1");
      expect(events[0]).toEqual([
        "session.rebindSession",
        "s1",
        "new",
        "android",
        { stableDeviceId: "new", deferCleanup: undefined, recovery: true },
      ]);
      expect(sessions.hasSession("s1")).toBe(true);
      expect(sessions.getSession("s1")?.assignedDevice).toBe("new");
      // A recovery rebind counts one generation and names the serial it left (#15456).
      expect(sessions.getSession("s1")).toMatchObject({
        deviceGeneration: 1,
        previousDeviceId: "old",
      });
    } finally {
      for (const restore of restores.reverse()) {
        restore();
      }
      pool.releaseDeviceClaimsForShutdown();
      sessions.stopCleanupTimer();
      timer.reset();
    }
  });
});
