import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DAEMON_REGISTER_SESSION_METHOD } from "../../src/daemon/constants";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  ObserverSessionRegistry,
  type ObserverSessionStore,
  MAX_OBSERVER_SESSIONS,
} from "../../src/daemon/observerSessionRegistry";
import { FakeObserverSessionRegistry } from "../fakes/FakeObserverSessionRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import type { DaemonRequest } from "../../src/daemon/types";

const sessionId = "00000000-0000-4000-8000-000000000001";
const request = (method: string, params: unknown): DaemonRequest => ({
  id: "test",
  type: "daemon_request",
  method,
  params,
});

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
    const expected = { success: false, error: `Session not found: ${sessionId}` };
    expect(await handleDaemonRequest(request("daemon/heartbeat", { sessionId }), state)).toEqual(
      expected,
    );
    registry.register(sessionId, "desktop");
    timer.advanceTime(10000);
    expect(await handleDaemonRequest(request("daemon/heartbeat", { sessionId }), state)).toEqual(
      expected,
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
    expect(observer).toEqual({ success: false, error: `Session not found: ${sessionId}` });
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
});
