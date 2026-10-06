import { expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntil } from "../helpers/fakeTimerStepping";

async function createContext(cancelDeviceExecutions?: () => Promise<number>) {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const manager = new SessionManager(timer, persistence, () => new FakeDbWriteBarrier());
  const devices = ["emulator-5554", "emulator-5556"].map((deviceId) => ({
    deviceId,
    name: deviceId,
    platform: "android" as const,
  }));
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("android", devices);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "binding-daemon", {
      timer,
      deviceManager: utils,
      idGenerator: new FakeIdGenerator(["owner"]),
      deviceSessionRepository: { markAutolockSession: async () => {} },
      cancelDeviceSessionExecutions: Object.assign(async () => 0, {
        cancelDeviceExecutions,
      }),
    }),
  );
  await pool.initializeWithDevices(devices);
  return { pool, manager, persistence, utils };
}

// #10332: reach the truth-table's "bound elsewhere" row without mutating
// session or pool internals. The old entry remains busy until its work drains.
for (const autolock of [false, true]) {
  test(`public rebind drains and releases only the old entry (autolock ${autolock})`, async () => {
    const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = autolock ? "1" : "0";
    const started = Promise.withResolvers<void>();
    const drain = Promise.withResolvers<number>();
    const { pool, manager, persistence } = await createContext(() => {
      started.resolve();
      return drain.promise;
    });
    try {
      if (autolock) {
        expect(await pool.autolockDevice("emulator-5554", "android", "client")).toBe("owner");
      } else {
        await pool.bindOrReuseDeviceSession("owner", "emulator-5554", "android");
      }
      const session = manager.getSession("owner");
      const rebind = pool.bindOrReuseDeviceSession(
        "owner",
        "emulator-5556",
        "android",
        undefined,
        undefined,
        undefined,
        true,
      );
      await started.promise;
      expect(manager.getSession("owner")).toBe(session);
      expect(manager.getDeviceForSession("owner")).toBe("emulator-5556");
      expect(manager.getSessionForDevice("emulator-5554")).toBeNull();
      expect(manager.getSessionForDevice("emulator-5556")).toBe("owner");
      for (const id of ["emulator-5554", "emulator-5556"]) {
        expect(pool.getDevice(id)).toMatchObject({ sessionId: "owner", status: "busy" });
      }
      expect(pool.getAvailableDeviceCount()).toBe(0);
      expect(await persistence.getSession?.("owner")).toMatchObject({
        device_id: "emulator-5556",
        status: "active",
        released_at_ms: null,
      });
      if (autolock) {
        expect(pool.getDevice("emulator-5554")?.autolockSessionId).toBeUndefined();
        expect(pool.resolveAutolockSessionForMcpSession("client")).toBe("owner");
        expect(
          pool.resolveAutolockSessionForMcpSession("client", "android", undefined, "emulator-5554"),
        ).toBeUndefined();
      }
      // A public acquisition queued during the split binding cannot commit to
      // the old entry while rebind owns the assignment mutex.
      const acquisition = autolock
        ? pool.autolockDevice("emulator-5554", "android", "client")
        : pool.bindOrReuseDeviceSession("next-owner", "emulator-5554", "android");
      drain.resolve(1);
      expect(await rebind).toBe("owner");
      const nextOwner = await acquisition;
      expect(nextOwner).toBeDefined();
      expect(nextOwner).not.toBe("owner");
      expect(pool.getDevice("emulator-5554")).toMatchObject({
        sessionId: nextOwner,
        status: "busy",
      });
      expect(pool.getDevice("emulator-5556")).toMatchObject({
        sessionId: "owner",
        status: "busy",
      });
      expect(manager.getDeviceForSession("owner")).toBe("emulator-5556");
      expect(await persistence.getSession?.("owner")).toMatchObject({
        device_id: "emulator-5556",
        status: "active",
        released_at_ms: null,
      });
      expect(await persistence.getSession?.(nextOwner!)).toMatchObject({
        device_id: "emulator-5554",
        status: "active",
      });
      await manager.releaseSession(nextOwner!);
      await pool.releaseDevice("emulator-5554", nextOwner!);
      expect(pool.getDevice("emulator-5554")).toMatchObject({ sessionId: null, status: "idle" });
      expect(pool.getAvailableDeviceCount()).toBe(1);
      expect(manager.getSession("owner")).toBe(session);
    } finally {
      drain.resolve(0);
      manager.stopCleanupTimer();
      if (originalAutolock === undefined) {
        delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      } else {
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
      }
    }
  });
}

test("idle assignment restores a tentative claim when the session already holds another device", async () => {
  const { pool, manager, persistence } = await createContext();
  try {
    await pool.bindOrReuseDeviceSession("owner", "emulator-5554", "android");
    const session = manager.getSession("owner");
    const result = await pool.assignDeviceToSession("owner", "android");
    expect(result).toBe("emulator-5554");
    expect(pool.getDevice("emulator-5554")).toMatchObject({ sessionId: "owner", status: "busy" });
    expect(pool.getDevice("emulator-5556")).toMatchObject({ sessionId: null, status: "idle" });
    expect(pool.getAvailableDeviceCount()).toBe(1);
    expect(manager.getSession("owner")).toBe(session);
    expect(manager.getDeviceForSession("owner")).toBe("emulator-5554");
    expect(await persistence.getSession?.("owner")).toMatchObject({
      device_id: "emulator-5554",
      status: "active",
      released_at_ms: null,
    });
  } finally {
    manager.stopCleanupTimer();
  }
});

test("public rebind cannot cross warm autolock's activity-refresh assignment fence", async () => {
  const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
  process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
  const { pool, manager, persistence, utils } = await createContext();
  const refreshStarted = Promise.withResolvers<void>();
  const refreshSettled = Promise.withResolvers<void>();
  try {
    await pool.autolockDevice("emulator-5554", "android", "client");
    const recordActivity = persistence.recordActivity.bind(persistence);
    persistence.recordActivity = async (sessionId, update) => {
      refreshStarted.resolve();
      await refreshSettled.promise;
      await recordActivity(sessionId, update);
    };
    const warm = pool.autolockDevice("emulator-5554", "android", "client");
    await refreshStarted.promise;
    const discoveries = utils.getBootedDevicesDetailedCalls().length;
    const rebind = pool.bindOrReuseDeviceSession(
      "owner",
      "emulator-5556",
      "android",
      undefined,
      undefined,
      undefined,
      true,
    );
    await drainUntil(() => utils.getBootedDevicesDetailedCalls().length > discoveries, {
      description: "queued rebind discovery",
    });
    expect(manager.getDeviceForSession("owner")).toBe("emulator-5554");
    expect(pool.getDevice("emulator-5556")).toMatchObject({ sessionId: null, status: "idle" });
    expect(await persistence.getSession?.("owner")).toMatchObject({
      device_id: "emulator-5554",
      status: "active",
    });
    refreshSettled.resolve();
    expect(await warm).toBe("owner");
    expect(await rebind).toBe("owner");
    expect(pool.getDevice("emulator-5554")).toMatchObject({ sessionId: null, status: "idle" });
    expect(pool.getDevice("emulator-5556")).toMatchObject({ sessionId: "owner", status: "busy" });
    expect(manager.getDeviceForSession("owner")).toBe("emulator-5556");
    expect(pool.getAvailableDeviceCount()).toBe(1);
    expect(await persistence.getSession?.("owner")).toMatchObject({
      device_id: "emulator-5556",
      status: "active",
      released_at_ms: null,
    });
  } finally {
    refreshSettled.resolve();
    manager.stopCleanupTimer();
    if (originalAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
    }
  }
});
