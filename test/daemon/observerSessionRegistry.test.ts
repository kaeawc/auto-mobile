import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ObserverSessionRegistry,
  MAX_OBSERVER_SESSIONS,
} from "../../src/daemon/observerSessionRegistry";
import { SessionManager, type SessionDeviceAssigner } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeObserverSessionRegistry } from "../fakes/FakeObserverSessionRegistry";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";

const sessionId = "00000000-0000-4000-8000-000000000001";

describe("ObserverSessionRegistry", () => {
  let timer: FakeTimer;
  let registry: ObserverSessionRegistry;
  let manager: SessionManager;

  beforeEach(() => {
    timer = new FakeTimer();
    registry = new ObserverSessionRegistry(timer, 10000);
    const barrier = new FakeDbWriteBarrier();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), () => barrier);
    manager.setObserverSessionRegistry(registry);
  });
  afterEach(() => {
    registry.dispose();
    manager.stopCleanupTimer();
  });

  test("registers and lists a device-less identity without creating a device session", () => {
    expect(registry.register(sessionId, "desktop")).toEqual({
      accepted: true,
      heartbeatTimeoutMs: 10000,
      expiresAtMs: 10000,
    });
    expect(registry.list()).toEqual([
      { sessionId, clientName: "desktop", lastHeartbeat: 0, expiresAtMs: 10000 },
    ]);
    expect(manager.getSession(sessionId)).toBeNull();
    expect(manager.getAllSessions()).toEqual([]);
  });

  test("re-registration is idempotent and refreshes TTL", () => {
    registry.register(sessionId, "desktop");
    timer.advanceTime(9000);
    registry.register(sessionId, "desktop-reconnected");
    timer.advanceTime(1000);
    expect(registry.list()).toEqual([
      { sessionId, clientName: "desktop-reconnected", lastHeartbeat: 9000, expiresAtMs: 19000 },
    ]);
  });

  test("heartbeat extends expiry and cannot revive an expired session", () => {
    registry.register(sessionId, "desktop");
    timer.advanceTime(9999);
    expect(registry.heartbeat(sessionId)).toBe(true);
    timer.advanceTime(10000);
    expect(registry.heartbeat(sessionId)).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  test("expiry removes at the deadline under FakeTimer", () => {
    registry.register(sessionId, "desktop");
    timer.advanceTime(10000);
    expect(registry.list()).toEqual([]);
  });

  test("explicit release removes the session", () => {
    registry.register(sessionId, "desktop");
    expect(registry.release(sessionId)).toBe(true);
    expect(registry.release(sessionId)).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  test("quota allows refresh at cap and expired entries free capacity", () => {
    for (let i = 0; i < MAX_OBSERVER_SESSIONS; i++) {
      registry.register(`observer-${i}`, "desktop");
    }
    expect(registry.register("overflow", "desktop")).toEqual({
      accepted: false,
      error: `Observer session limit (${MAX_OBSERVER_SESSIONS}) reached; release a session or wait for heartbeat expiry before retrying`,
    });
    timer.advanceTime(1);
    expect(registry.register("observer-0", "desktop").accepted).toBe(true);
    timer.advanceTime(9999);
    expect(registry.register("new", "desktop").accepted).toBe(true);
    expect(registry.list().map((session) => session.sessionId)).toEqual(["observer-0", "new"]);
  });

  test("scope admits only unowned devices for a live observer", () => {
    registry.register(sessionId, "desktop");
    const ownership = {
      getSessionForDevice: (deviceId: string) => (deviceId === "idle" ? null : "another-session"),
    };
    expect(registry.resolveObserverScope(sessionId)).toEqual({ kind: "unowned-devices-only" });
    expect(registry.canObserveDevice(sessionId, "idle", ownership)).toBe(true);
    expect(registry.canObserveDevice(sessionId, "owned", ownership)).toBe(false);
    expect(registry.canObserveDevice("unknown", "idle", ownership)).toBe(false);
    timer.advanceTime(10000);
    expect(registry.resolveObserverScope(sessionId)).toEqual({ kind: "denied" });
    expect(registry.canObserveDevice(sessionId, "idle", ownership)).toBe(false);
  });

  test("restart loses registrations and disposal leaks no expiry timer", () => {
    registry.register(sessionId, "desktop");
    const restarted = new ObserverSessionRegistry(timer);
    expect(restarted.heartbeat(sessionId)).toBe(false);
    expect(restarted.list()).toEqual([]);
    // Only the registry holding an observer arms its expiry sweep (#11076).
    expect(timer.getPendingTimeoutCount()).toBe(1);
    registry.dispose();
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(registry.list()).toEqual([]);
    expect(registry.register(sessionId, "desktop").accepted).toBe(false);
    restarted.dispose();
  });

  test("publication promotes and release never recreates an observer", async () => {
    registry.register(sessionId, "desktop");
    manager.onSessionCreated(() => expect(registry.list()).toEqual([]));
    await manager.createSession(sessionId, "device-a", "android");
    expect(registry.list()).toEqual([]);
    expect(manager.getSession(sessionId)?.assignedDevice).toBe("device-a");
    await manager.releaseSession(sessionId);
    expect(registry.list()).toEqual([]);
    expect(registry.heartbeat(sessionId)).toBe(false);
  });

  test("rehydration also promotes the observer before publishing a device session", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const barrier = new FakeDbWriteBarrier();
    const prior = new SessionManager(timer, persistence, () => barrier);
    const restarted = new SessionManager(timer, persistence, () => barrier);
    restarted.setObserverSessionRegistry(registry);
    try {
      await prior.createSession(sessionId, "device-a", "android");
      await prior.releaseSession(sessionId, "daemon-restart");
      registry.register(sessionId, "desktop");
      const pool: SessionDeviceAssigner = {
        assignDeviceToSession: async (id, _platform, target) => {
          const session = await restarted.createSession(
            id,
            "device-a",
            "android",
            target?.liveness?.sessionTimeoutMs,
            target?.liveness?.heartbeatTimeoutMs,
            target?.stableDeviceId,
            target?.liveness,
            target?.initialOwnership,
          );
          return session.assignedDevice;
        },
      };
      const result = await restarted.rehydratePersistedSessions(pool);
      expect(result.rehydrated).toEqual([sessionId]);
      expect(registry.list()).toEqual([]);
      expect(restarted.getSession(sessionId)?.assignedDevice).toBe("device-a");
    } finally {
      prior.stopCleanupTimer();
      restarted.stopCleanupTimer();
    }
  });

  test("promotion uses the narrow registry fake and reason", async () => {
    const fake = new FakeObserverSessionRegistry();
    manager.setObserverSessionRegistry(fake);
    fake.register(sessionId, "desktop");
    await manager.createSession(sessionId, "device-a", "android");
    expect(fake.releases).toEqual([{ sessionId, reason: "promotion" }]);
    expect(fake.list()).toEqual([]);
  });

  test("device-tool admission rejects observers exactly like unknown UUIDs without allocation", async () => {
    registry.register(sessionId, "desktop");
    const assignments: string[] = [];
    const pool: SessionDeviceAssigner = {
      assignDeviceToSession: async (id) => {
        assignments.push(id);
        return "device-a";
      },
    };
    const errorFor = async (id: string): Promise<string> => {
      try {
        await manager.getOrCreateSession(id, pool, "android", undefined, true);
        throw new Error("unexpected admission");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        return error instanceof Error ? error.message.replace(id, "UUID") : "unexpected error";
      }
    };
    expect(await errorFor(sessionId)).toBe(await errorFor("unknown"));
    expect(await errorFor(sessionId)).toContain("not an active daemon session (not found)");
    expect(manager.getSessionForNewExecution(sessionId)).toBeNull();
    expect(assignments).toEqual([]);
  });

  test("a live observer leaves every idle device available to CLI sessions", async () => {
    registry.register(sessionId, "desktop");
    const devices = ["device-a", "device-b"].map((deviceId) => ({
      deviceId,
      name: deviceId,
      platform: "android" as const,
    }));
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "test-daemon", {
        timer,
        deviceManager: new FakeDeviceManager([], devices),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices(devices);
    for (const device of devices) {
      pool.notifyDeviceReady(device.deviceId);
    }
    expect(pool.getStats().idle).toBe(2);
    await Promise.all(
      devices.map((_, index) => pool.assignDeviceToSession(`cli-${index}`, "android")),
    );
    expect(pool.getStats().idle).toBe(0);
    expect(pool.getStats().assigned).toBe(2);
    expect(registry.list()).toHaveLength(1);
  });
});

describe("ObserverSessionRegistry gone callback", () => {
  test("fires on explicit release and heartbeat expiry but not on promotion", () => {
    const timer = new FakeTimer();
    const gone: string[] = [];
    const registry = new ObserverSessionRegistry(timer, 10000, (id) => gone.push(id));
    registry.register("a", "c");
    registry.register("b", "c");
    registry.register("c", "c");
    registry.release("a");
    registry.release("b", "promotion");
    expect(gone).toEqual(["a"]);
    timer.advanceTime(10000);
    registry.list();
    expect(gone).toEqual(["a", "c"]);
    registry.dispose();
  });

  test("a heartbeat timeout fires on the injected timer without any registry lookup (#11076)", () => {
    const timer = new FakeTimer();
    const gone: string[] = [];
    const registry = new ObserverSessionRegistry(timer, 10000, (id) => gone.push(id));
    registry.register("a", "c");
    timer.advanceTime(5000);
    registry.register("b", "c");
    timer.advanceTime(4000);
    // A heartbeat pushes "a" past the first sweep; that sweep fires early and re-arms.
    expect(registry.heartbeat("a")).toBe(true);
    timer.advanceTime(1000);
    expect(gone).toEqual([]);
    timer.advanceTime(5000);
    expect(gone).toEqual(["b"]);
    timer.advanceTime(4000);
    expect(gone).toEqual(["b", "a"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    registry.dispose();
  });

  test("dispose cancels the pending sweep", () => {
    const timer = new FakeTimer();
    const gone: string[] = [];
    const registry = new ObserverSessionRegistry(timer, 10000, (id) => gone.push(id));
    registry.register("a", "c");
    registry.dispose();
    timer.advanceTime(20000);
    expect(gone).toEqual([]);
  });
});
