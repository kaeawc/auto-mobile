import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import {
  DAEMON_REGISTER_SESSION_METHOD,
  SESSION_RELEASE_DRAIN_TIMEOUT_MS,
} from "../../src/daemon/constants";
import {
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SessionManager,
} from "../../src/daemon/sessionManager";
import {
  ObserverSessionRegistry,
  type ObserverSessionStore,
  MAX_OBSERVER_SESSIONS,
} from "../../src/daemon/observerSessionRegistry";
import { FakeObserverSessionRegistry } from "../fakes/FakeObserverSessionRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { DAEMON_SESSION_NOT_FOUND_CODE, type DaemonRequest } from "../../src/daemon/types";

const sessionId = "00000000-0000-4000-8000-000000000001";
const notFound = {
  success: false,
  error: `Session not found: ${sessionId}`,
  code: DAEMON_SESSION_NOT_FOUND_CODE,
};
const request = (method: string, params: unknown): DaemonRequest => ({
  id: "test",
  type: "daemon_request",
  method,
  params,
});

class DeferredReleasePersistence extends FakeDeviceSessionPersistence {
  readonly releaseStarted = Promise.withResolvers<void>();
  readonly finishRelease = Promise.withResolvers<void>();

  override async markReleased(
    ...args: Parameters<FakeDeviceSessionPersistence["markReleased"]>
  ): Promise<void> {
    this.releaseStarted.resolve();
    await this.finishRelease.promise;
    await super.markReleased(...args);
  }
}

describe("registration-only daemon requests", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let registry: ObserverSessionStore;
  let poolLookups: number;
  let state: DaemonStateAccess;

  beforeEach(() => {
    timer = new FakeTimer();
    const barrier = new FakeDbWriteBarrier();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), () => barrier);
    registry = new ObserverSessionRegistry(timer, 10000);
    manager.setObserverSessionRegistry(registry);
    poolLookups = 0;
    state = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getObserverSessionRegistry: () => registry,
      getDeviceSessionRegistry: () => ({ list: () => [] }),
      getDevicePool: () => {
        poolLookups++;
        throw new Error("Observer request must not consult the pool");
      },
    };
  });
  afterEach(() => {
    registry.dispose();
    manager.stopCleanupTimer();
  });

  test("register, heartbeat and release do not assign or release devices", async () => {
    const response = await handleDaemonRequest(
      request(DAEMON_REGISTER_SESSION_METHOD, { sessionId, clientName: "desktop" }),
      state,
    );
    expect(response).toEqual({
      success: true,
      result: { accepted: true, heartbeatTimeoutMs: 10000, expiresAtMs: 10000 },
    });
    timer.advanceTime(9000);
    expect(await handleDaemonRequest(request("daemon/heartbeat", { sessionId }), state)).toEqual({
      success: true,
      result: { sessionId },
    });
    expect(registry.list()[0]?.expiresAtMs).toBe(19000);
    expect(
      await handleDaemonRequest(request("daemon/releaseSession", { sessionId }), state),
    ).toEqual({
      success: true,
      result: { message: `Session ${sessionId} released`, alreadyReleased: false },
    });
    expect(registry.list()).toEqual([]);
    expect(manager.getAllSessions()).toEqual([]);
    expect(poolLookups).toBe(0);
  });

  for (const params of [
    {},
    { clientName: "desktop" },
    { sessionId },
    { sessionId: "", clientName: "desktop" },
    { sessionId: " ", clientName: "desktop" },
    { sessionId: "x".repeat(129), clientName: "desktop" },
    { sessionId: "not-a-uuid", clientName: "desktop" },
    { sessionId: 3, clientName: "desktop" },
    { sessionId, clientName: "" },
    { sessionId, clientName: "  " },
    { sessionId, clientName: "x".repeat(129) },
    { sessionId, clientName: 3 },
    null,
    [],
  ]) {
    test(`validates wire parameters ${JSON.stringify(params)}`, async () => {
      const response = await handleDaemonRequest(
        request(DAEMON_REGISTER_SESSION_METHOD, params),
        state,
      );
      expect(response.success).toBe(false);
      expect(response.error).toContain("Invalid registerSession parameters");
      expect(registry.list()).toEqual([]);
      expect(poolLookups).toBe(0);
    });
  }

  test("unknown and expired heartbeat keep the existing error", async () => {
    expect(await handleDaemonRequest(request("daemon/heartbeat", { sessionId }), state)).toEqual(
      notFound,
    );
    registry.register(sessionId, "desktop");
    timer.advanceTime(10000);
    expect(await handleDaemonRequest(request("daemon/heartbeat", { sessionId }), state)).toEqual(
      notFound,
    );
  });

  test("quota is a typed daemon failure and cap refresh succeeds", async () => {
    for (let i = 0; i < MAX_OBSERVER_SESSIONS; i++) {
      registry.register(`observer-${i}`, "desktop");
    }
    const response = await handleDaemonRequest(
      request(DAEMON_REGISTER_SESSION_METHOD, { sessionId, clientName: "desktop" }),
      state,
    );
    expect(response.success).toBe(false);
    expect(response.error).toContain("limit (32)");
    expect(response.error).toContain("release a session or wait");
    timer.advanceTime(10000);
    expect(
      (
        await handleDaemonRequest(
          request(DAEMON_REGISTER_SESSION_METHOD, { sessionId, clientName: "desktop" }),
          state,
        )
      ).success,
    ).toBe(true);
  });

  test("device sessions win heartbeat and release over observer seams", async () => {
    const fake = new FakeObserverSessionRegistry();
    registry = fake;
    await manager.createSession(sessionId, "device-a", "android");
    fake.register(sessionId, "desktop"); // Deliberately overlapping fake to verify precedence.
    timer.advanceTime(1);
    await handleDaemonRequest(request("daemon/heartbeat", { sessionId }), state);
    expect(manager.getSession(sessionId)?.lastHeartbeat).toBe(1);
    expect(fake.heartbeats).toEqual([]);
    const released: string[] = [];
    state.getDevicePool = () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
      releaseDevice: async (deviceId) => {
        released.push(deviceId);
      },
    });
    await handleDaemonRequest(request("daemon/releaseSession", { sessionId }), state);
    expect(released).toEqual(["device-a"]);
    expect(fake.releases).toEqual([]);
  });

  test("device-bound sessionInfo rejects an observer exactly like an unknown session", async () => {
    registry.register(sessionId, "desktop");
    const observer = await handleDaemonRequest(request("daemon/sessionInfo", { sessionId }), state);
    const unknown = await handleDaemonRequest(
      request("daemon/sessionInfo", { sessionId: "unknown" }),
      state,
    );
    expect(observer).toEqual(notFound);
    expect(observer.error?.replace(sessionId, "UUID")).toBe(
      unknown.error?.replace("unknown", "UUID"),
    );
    expect(poolLookups).toBe(0);
  });

  test("registering an active device UUID never creates an observer", async () => {
    await manager.createSession(sessionId, "device-a", "android");
    expect(
      (
        await handleDaemonRequest(
          request(DAEMON_REGISTER_SESSION_METHOD, { sessionId, clientName: "desktop" }),
          state,
        )
      ).success,
    ).toBe(true);
    expect(registry.list()).toEqual([]);
  });

  test("registration waits for teardown, then registers an observer that can heartbeat", async () => {
    const session = await manager.createSession(sessionId, "device-a", "android");
    session.heartbeatTimeoutMs = 20000;
    const finishSetup = Promise.withResolvers<void>();
    const setup = manager.trackSessionSetup(session, () => finishSetup.promise);
    const release = manager.releaseSession(sessionId, "explicit-release");
    let responded = false;
    const registration = handleDaemonRequest(
      request(DAEMON_REGISTER_SESSION_METHOD, { sessionId, clientName: "desktop" }),
      state,
    ).then((response) => {
      responded = true;
      return response;
    });
    try {
      // Await another UUID's registration to flush the immediate-response path as well
      // as proving that the first UUID's release does not block other registrations.
      const otherId = "00000000-0000-4000-8000-000000000002";
      const unrelated = await handleDaemonRequest(
        request(DAEMON_REGISTER_SESSION_METHOD, { sessionId: otherId, clientName: "other" }),
        state,
      );
      expect(unrelated.success).toBe(true);
      registry.release(otherId);
      expect(responded).toBe(false);
      expect(registry.list()).toEqual([]);
      expect(manager.getSession(sessionId)).toBe(session);

      finishSetup.resolve();
      await setup;
      await release;
      expect(await registration).toEqual({
        success: true,
        result: { accepted: true, heartbeatTimeoutMs: 10000, expiresAtMs: 10000 },
      });
      expect(registry.list()).toHaveLength(1);
      expect(registry.list()[0]?.sessionId).toBe(sessionId);
      expect(manager.getSession(sessionId)).toBeNull();
      expect(await handleDaemonRequest(request("daemon/heartbeat", { sessionId }), state)).toEqual({
        success: true,
        result: { sessionId },
      });
      // Only the observer's expiry sweep (#11076); no device-session timer.
      expect(timer.getPendingTimeoutCount()).toBe(1);
    } finally {
      finishSetup.resolve();
      await release;
      await registration;
    }
  });

  test("registration returns a retry failure at the release deadline without an observer", async () => {
    const persistence = new DeferredReleasePersistence();
    manager.stopCleanupTimer();
    manager = new SessionManager(timer, persistence, () => new FakeDbWriteBarrier());
    manager.setObserverSessionRegistry(registry);
    await manager.createSession(sessionId, "device-a", "android");
    const release = manager.releaseSession(sessionId, "explicit-release");
    await persistence.releaseStarted.promise;
    const registration = handleDaemonRequest(
      request(DAEMON_REGISTER_SESSION_METHOD, { sessionId, clientName: "desktop" }),
      state,
    );
    try {
      timer.advanceTime(SESSION_RELEASE_DRAIN_TIMEOUT_MS);
      expect(await registration).toEqual({
        success: false,
        error: `Session ${sessionId} release is still in progress after ${SESSION_RELEASE_DRAIN_TIMEOUT_MS}ms; retry registration`,
      });
      expect(registry.list()).toEqual([]);
      // Only the still-running release's own write deadline (#10836) remains.
      expect(timer.getPendingTimeouts()).toEqual([SESSION_RELEASE_PERSIST_TIMEOUT_MS]);
      expect(timer.getPendingSleepCount()).toBe(0);
    } finally {
      persistence.finishRelease.resolve();
      await release;
    }
  });

  test("registration succeeds as an observer after an in-flight release rejects", async () => {
    const persistence = new DeferredReleasePersistence();
    manager.stopCleanupTimer();
    manager = new SessionManager(timer, persistence, () => new FakeDbWriteBarrier());
    manager.setObserverSessionRegistry(registry);
    await manager.createSession(sessionId, "device-a", "android");
    const release = manager.releaseSession(sessionId, "device-restart:device-a");
    const releaseError = release.then(
      () => null,
      (error: unknown) => error,
    );
    await persistence.releaseStarted.promise;
    let responded = false;
    const registration = handleDaemonRequest(
      request(DAEMON_REGISTER_SESSION_METHOD, { sessionId, clientName: "desktop" }),
      state,
    ).then((response) => {
      responded = true;
      return response;
    });
    try {
      const otherId = "00000000-0000-4000-8000-000000000002";
      await handleDaemonRequest(
        request(DAEMON_REGISTER_SESSION_METHOD, { sessionId: otherId, clientName: "other" }),
        state,
      );
      registry.release(otherId);
      expect(responded).toBe(false);
      expect(registry.list()).toEqual([]);
      persistence.finishRelease.reject(new Error("release write failed"));
      expect(await releaseError).toBeInstanceOf(Error);
      expect(await registration).toEqual({
        success: true,
        result: { accepted: true, heartbeatTimeoutMs: 10000, expiresAtMs: 10000 },
      });
      expect(registry.list()).toHaveLength(1);
      expect(manager.getSession(sessionId)).toBeNull();
      // Only the observer's expiry sweep (#11076); no device-session timer.
      expect(timer.getPendingTimeoutCount()).toBe(1);
    } finally {
      persistence.finishRelease.reject(new Error("release write failed"));
      await releaseError;
      await registration;
    }
  });

  test("registration rechecks a device session published while release was in flight", async () => {
    const session = await manager.createSession(sessionId, "device-a", "android");
    session.heartbeatTimeoutMs = 20000;
    const finishRelease = Promise.withResolvers<void>();
    let publishedSession = session;
    state.getSessionManager = () => ({
      getSession: () => publishedSession,
      getDeviceLabels: () => undefined,
      releaseSession: async () => null,
      waitForSessionReleaseWithin: async () => {
        await finishRelease.promise;
        return true;
      },
    });
    const registration = handleDaemonRequest(
      request(DAEMON_REGISTER_SESSION_METHOD, { sessionId, clientName: "desktop" }),
      state,
    );
    try {
      expect(registry.list()).toEqual([]);
      publishedSession = { ...session, assignedDevice: "device-b", heartbeatTimeoutMs: 30000 };
      finishRelease.resolve();
      expect(await registration).toEqual({
        success: true,
        result: { accepted: true, heartbeatTimeoutMs: 30000, expiresAtMs: 30000 },
      });
      expect(state.getSessionManager().getSession(sessionId)?.assignedDevice).toBe("device-b");
      expect(registry.list()).toEqual([]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      finishRelease.resolve();
      await registration;
    }
  });
});
