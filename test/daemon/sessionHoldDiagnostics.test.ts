import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  handleActiveSessions,
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { ObserverSessionRegistry } from "../../src/daemon/observerSessionRegistry";
import {
  classifySessionHolderKind,
  idleReleaseAt,
  sessionHoldDiagnostics,
  type SessionHoldSnapshot,
} from "../../src/daemon/sessionHoldDiagnostics";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { DaemonRequest } from "../../src/daemon/types";
import { ExecutionTracker } from "../../src/server/executionTracker";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// #10671: session-info could not tell an idle-but-live holder from an active one,
// and named no holder. These pin the diagnostics that separate them.

const SESSION = "00000000-0000-4000-8000-000000000071";
const DEVICE = "emulator-5554";

function snapshot(overrides: Partial<SessionHoldSnapshot> = {}): SessionHoldSnapshot {
  return {
    lastUsedAt: 1_000,
    expiresAt: 121_000,
    livenessPolicy: "heartbeat",
    hasReceivedHeartbeat: true,
    ownership: "owned",
    heartbeatTimeoutMs: 4_000,
    ...overrides,
  };
}

const request = (method: string, params: Record<string, unknown> = {}): DaemonRequest => ({
  id: "request-1",
  type: "daemon_request",
  method,
  params,
});

function stateFor(manager: SessionManager, observers?: ObserverSessionRegistry): DaemonStateAccess {
  return {
    isInitialized: () => true,
    getSessionManager: () => manager,
    getObserverSessionRegistry: () => observers,
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
      releaseDevice: async () => {},
    }),
    getDeviceSessionRegistry: () => ({ list: () => [] }),
  };
}

describe("classifySessionHolderKind", () => {
  test.each([
    [{ livenessPolicy: "cli-idle" as const, livenessOwnerToken: "t" }, "cli"],
    [{ livenessPolicy: "heartbeat" as const, livenessOwnerToken: "t" }, "stdio-proxy"],
    [{ livenessPolicy: "heartbeat" as const, clientName: "AutoMobile Desktop" }, "desktop"],
    [{ livenessPolicy: "heartbeat" as const, clientName: "AutoMobile IDE plugin" }, "ide"],
    [{ livenessPolicy: "heartbeat" as const, clientName: "AutoMobile JUnitRunner" }, "junit"],
    [{ livenessPolicy: "heartbeat" as const, clientName: "something else" }, "unknown"],
    [{ livenessPolicy: "heartbeat" as const }, "unknown"],
  ])("%o is %s", (session, kind) => {
    expect(classifySessionHolderKind(session)).toBe(kind);
  });

  test("a registered client name wins over the proxy token", () => {
    expect(
      classifySessionHolderKind({
        livenessPolicy: "heartbeat",
        livenessOwnerToken: "t",
        clientName: "AutoMobile Desktop",
      }),
    ).toBe("desktop");
  });
});

describe("idleReleaseAt", () => {
  test("a heartbeating owner gets the suspect grace past expiresAt", () => {
    expect(idleReleaseAt(snapshot())).toBe(121_000 + SUSPECT_GRACE_MS);
  });

  test("a session no owner has heartbeated expires at expiresAt", () => {
    expect(idleReleaseAt(snapshot({ hasReceivedHeartbeat: false }))).toBe(121_000);
  });

  test("a CLI session is released its idle timeout after its last tool activity", () => {
    expect(
      idleReleaseAt(snapshot({ livenessPolicy: "cli-idle", heartbeatTimeoutMs: 120_000 })),
    ).toBe(121_000);
  });

  test("diagnostics report a missing owner heartbeat as null", () => {
    expect(sessionHoldDiagnostics(snapshot(), 2)).toEqual({
      lastToolActivityAt: 1_000,
      lastOwnerHeartbeatAt: null,
      idleReleaseAt: 121_000 + SUSPECT_GRACE_MS,
      holderKind: "unknown",
      activeExecutions: 2,
    });
  });
});

describe("session hold diagnostics through the daemon surfaces", () => {
  let timer: FakeTimer;
  let manager: SessionManager;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  test("an owner heartbeat moves lastOwnerHeartbeatAt but not tool activity or idle release", async () => {
    const session = await manager.createSession(SESSION, DEVICE, "android");
    const state = stateFor(manager);
    const before = (
      await handleDaemonRequest(request("daemon/sessionInfo", { sessionId: SESSION }), state)
    ).result;
    timer.advanceTime(30_000);
    const claim = await handleDaemonRequest(
      request("daemon/heartbeat", {
        sessionId: SESSION,
        livenessOwnerToken: "proxy-token",
        claimLivenessOwnership: true,
      }),
      state,
    );
    expect(claim.success).toBe(true);

    const after = (
      await handleDaemonRequest(request("daemon/sessionInfo", { sessionId: SESSION }), state)
    ).result;
    expect(after).toMatchObject({
      lastToolActivityAt: before?.lastToolActivityAt,
      lastOwnerHeartbeatAt: session.lastOwnerHeartbeat,
      idleReleaseAt: session.expiresAt + SUSPECT_GRACE_MS,
      holderKind: "stdio-proxy",
      activeExecutions: 0,
    });
    expect(after?.lastOwnerHeartbeatAt).toBeGreaterThan(Number(before?.lastToolActivityAt));
    expect(before?.lastOwnerHeartbeatAt).toBeNull();
  });

  test("registering a client name on an existing session names its holder", async () => {
    await manager.createSession(SESSION, DEVICE, "android");
    const state = stateFor(manager, new ObserverSessionRegistry(timer));
    const registered = await handleDaemonRequest(
      request("daemon/registerSession", { sessionId: SESSION, clientName: "AutoMobile Desktop" }),
      state,
    );
    expect(registered.success).toBe(true);
    const info = await handleDaemonRequest(
      request("daemon/sessionInfo", { sessionId: SESSION }),
      state,
    );
    expect(info.result?.holderKind).toBe("desktop");
  });

  test("an observer's client name follows it when it acquires a device", async () => {
    const observers = new ObserverSessionRegistry(timer);
    manager.setObserverSessionRegistry(observers);
    expect(observers.register(SESSION, "AutoMobile Desktop").accepted).toBe(true);

    const session = await manager.createSession(SESSION, DEVICE, "android");

    expect(session.clientName).toBe("AutoMobile Desktop");
    expect(observers.list()).toEqual([]);
  });

  test("a one-shot CLI owner is reported as cli with its wall-clock idle deadline", async () => {
    const session = await manager.createSession(SESSION, DEVICE, "android");
    expect(manager.adoptCliLivenessPolicy(SESSION, 60_000)).toBe(true);
    const info = await handleDaemonRequest(
      request("daemon/sessionInfo", { sessionId: SESSION }),
      stateFor(manager),
    );
    expect(info.result).toMatchObject({
      holderKind: "cli",
      idleReleaseAt: session.lastUsedAt + 60_000,
    });
  });

  test("activeSessions lists each held session only when asked, with its in-flight count", async () => {
    await manager.createSession(SESSION, DEVICE, "android");
    const state = stateFor(manager);
    const counter = {
      getActiveExecutionCount: () => 3,
      getActiveDeviceSessionExecutionCount: (sessionUuid: string) =>
        sessionUuid === SESSION ? 2 : 0,
    };

    expect(
      (await handleActiveSessions(request("daemon/activeSessions"), state, counter)).result,
    ).toEqual({ activeSessions: 1, activeExecutions: 3 });
    const detailed = await handleActiveSessions(
      request("daemon/activeSessions", { includeSessions: true }),
      state,
      counter,
    );
    expect(detailed.result?.sessions).toEqual([
      expect.objectContaining({
        sessionId: SESSION,
        assignedDevice: DEVICE,
        platform: "android",
        holderKind: "unknown",
        activeExecutions: 2,
      }),
    ]);
  });
});

describe("ExecutionTracker.getActiveDeviceSessionExecutionCount", () => {
  test("counts explicit, resolved-autolock and unresolved-autolock work once each", () => {
    const tracker = new ExecutionTracker(
      new FakeTimer(),
      new FakeIdGenerator(["owned", "autolock", "provisional", "peer"]),
    );
    tracker.setAutolockSessionResolver({ autolockSessionForMcpSession: () => SESSION });
    const owned = tracker.startExecution("observe", undefined, SESSION);
    const autolock = tracker.startExecution("tapOn");
    tracker.setResolvedAutolockSessionUuid(autolock.id, SESSION);
    tracker.startExecution("swipeOn", undefined, undefined, undefined, "mcp-1");
    tracker.startExecution("observe", undefined, "other-session");

    expect(tracker.getActiveDeviceSessionExecutionCount(SESSION)).toBe(3);
    tracker.endExecution(owned.id);
    expect(tracker.getActiveDeviceSessionExecutionCount(SESSION)).toBe(2);
    expect(tracker.getActiveDeviceSessionExecutionCount("other-session")).toBe(1);
    expect(tracker.getActiveDeviceSessionExecutionCount("none")).toBe(0);
  });
});
