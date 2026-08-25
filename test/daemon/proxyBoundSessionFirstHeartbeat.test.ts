import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  DaemonClient,
  DaemonUnavailableError,
  type DaemonClientLike,
} from "../../src/daemon/client";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";

// Reproduces issue #5637: a proxy-bound MCP session allocated shortly before the
// proxy starts up must not be reaped with `missing-first-heartbeat` before its
// first ownership heartbeat reaches the daemon. The tension is with the
// pre-first-heartbeat fast-reclaim added in #2443 (a client that dies before its
// first heartbeat is reclaimed quickly): the fix must keep that reclaim intact
// (AC4) while guaranteeing a healthy connecting client delivers its first
// heartbeat as part of connection establishment (AC1/AC2).

const BOUND_SESSION = "device-session-a";

const HEARTBEAT_ENV_KEYS = [
  "AUTOMOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS",
  "AUTOMOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS",
  "AUTOMOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
  "AUTO_MOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
  "AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
] as const;

function clearHeartbeatEnv(): void {
  for (const key of HEARTBEAT_ENV_KEYS) {
    delete process.env[key];
  }
}

// A FakeDaemonManager reporting a running daemon whose version matches this
// client, so the version/build handshake in doConnect() is a no-op.
function matchingDaemonManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
}

// A FakeDaemonClient that forwards `daemon/heartbeat` to a real SessionManager,
// so a proxy heartbeat exercises the exact daemon-side ownership bookkeeping the
// monitor consults.
function heartbeatForwardingClient(sessionManager: SessionManager): FakeDaemonClient {
  return new FakeDaemonClient({
    onCallDaemonMethod: (method, params) => {
      if (method === "daemon/heartbeat" && typeof params.sessionId === "string") {
        sessionManager.recordHeartbeat(params.sessionId);
      }
    },
  });
}

describe("proxy-bound session first heartbeat (issue #5637)", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let reaped: Array<{ sessionId: string; reason: string }>;
  let monitor: SessionHeartbeatMonitor;

  beforeEach(() => {
    clearHeartbeatEnv();
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    reaped = [];
    monitor = new SessionHeartbeatMonitor(
      sessionManager,
      () => false,
      async (sessionId, reason) => {
        reaped.push({ sessionId, reason });
        await sessionManager.releaseSession(sessionId);
      },
      timer,
    );
  });

  afterEach(async () => {
    await monitor.stop();
    sessionManager.stopCleanupTimer();
    clearHeartbeatEnv();
  });

  // AC1 + AC2 (default timeout path): a bound session allocated shortly before
  // the proxy starts survives because the first heartbeat is delivered as part of
  // connection establishment.
  test("delivers the first heartbeat during establishment for a default-timeout session", async () => {
    await sessionManager.createSession(BOUND_SESSION, "emulator-5554", "android", 60_000);
    monitor.start();
    // Some time passes before the client actually starts its proxy, but still
    // within the daemon's pre-first-heartbeat grace.
    timer.advanceTime(4_000);

    const fakeClient = heartbeatForwardingClient(sessionManager);
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      initialSessionUuid: BOUND_SESSION,
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
    });

    try {
      await proxy.ensureConnected();

      // The guarantee: once the connection is established, the daemon has already
      // recorded the first ownership heartbeat.
      expect(sessionManager.getSession(BOUND_SESSION)?.hasReceivedHeartbeat).toBe(true);

      // Advance well past the pre-first-heartbeat grace; the keeper keeps the
      // ownership fresh, so the session is never reaped.
      await timer.advanceTimeAsync(6_000);
      await monitor.tick();

      expect(reaped).toEqual([]);
      expect(sessionManager.getSession(BOUND_SESSION)).not.toBeNull();
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  // AC1 + AC2 (constrained timeout path): the same guarantee holds when the proxy
  // and session carry a small, explicit heartbeat timeout.
  test("delivers the first heartbeat during establishment for a constrained-timeout session", async () => {
    await sessionManager.createSession(BOUND_SESSION, "emulator-5554", "android", 60_000, 1_000);
    monitor.start();
    timer.advanceTime(400);

    const fakeClient = heartbeatForwardingClient(sessionManager);
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      initialSessionUuid: BOUND_SESSION,
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
      heartbeatTimeoutMs: 1_000,
    });

    try {
      await proxy.ensureConnected();

      expect(sessionManager.getSession(BOUND_SESSION)?.hasReceivedHeartbeat).toBe(true);

      // Past the constrained timeout, but the keeper (interval = timeout/2) keeps
      // refreshing ownership, so the session survives.
      await timer.advanceTimeAsync(2_000);
      await monitor.tick();

      expect(reaped).toEqual([]);
      expect(sessionManager.getSession(BOUND_SESSION)).not.toBeNull();
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  // AC1: connection establishment must not resolve for a bound session until the
  // daemon has received the first ownership heartbeat. This is the contractual
  // guarantee — a fire-and-forget dispatch that merely races the pre-first
  // reclaim is what regresses.
  test("does not resolve establishment until the first heartbeat is delivered", async () => {
    await sessionManager.createSession(BOUND_SESSION, "emulator-5554", "android", 60_000);

    const released = Promise.withResolvers<void>();
    let heartbeatObserved = false;
    const fakeClient = new FakeDaemonClient({
      onCallDaemonMethod: async (method, params) => {
        if (method === "daemon/heartbeat" && typeof params.sessionId === "string") {
          heartbeatObserved = true;
          await released.promise;
          sessionManager.recordHeartbeat(params.sessionId);
        }
      },
    });
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      initialSessionUuid: BOUND_SESSION,
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
    });

    try {
      let established = false;
      const connectPromise = proxy.ensureConnected().then(() => {
        established = true;
      });

      // Let the connection reach the (gated) first heartbeat.
      for (let i = 0; i < 50 && !heartbeatObserved; i++) {
        await Promise.resolve();
      }
      expect(heartbeatObserved).toBe(true);
      // Give any (incorrect) fire-and-forget path a chance to resolve
      // establishment early; the awaited path must keep it pending.
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
      // Establishment must still be pending: the heartbeat has not completed.
      expect(established).toBe(false);
      expect(sessionManager.getSession(BOUND_SESSION)?.hasReceivedHeartbeat).toBe(false);

      released.resolve();
      await connectPromise;
      expect(established).toBe(true);
      expect(sessionManager.getSession(BOUND_SESSION)?.hasReceivedHeartbeat).toBe(true);
    } finally {
      released.resolve();
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  // issue #5643: a CONCURRENT ensureConnected() (e.g. a parallel listTools/callTool
  // during MCP startup) that arrives while the establishment heartbeat is still in
  // flight must not resolve on the `connected` fast path before the daemon has
  // recorded the first ownership heartbeat. The establishment guarantee must hold
  // for concurrent callers, not just the one that triggered doConnect().
  test("holds a concurrent ensureConnected() until the first heartbeat is recorded", async () => {
    await sessionManager.createSession(BOUND_SESSION, "emulator-5554", "android", 60_000);

    const released = Promise.withResolvers<void>();
    let heartbeatObserved = false;
    const fakeClient = new FakeDaemonClient({
      onCallDaemonMethod: async (method, params) => {
        if (method === "daemon/heartbeat" && typeof params.sessionId === "string") {
          heartbeatObserved = true;
          await released.promise;
          sessionManager.recordHeartbeat(params.sessionId);
        }
      },
    });
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      initialSessionUuid: BOUND_SESSION,
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
    });

    try {
      // First caller triggers doConnect(); its establishment heartbeat is gated.
      const firstConnect = proxy.ensureConnected();

      // Let the connection reach the (gated) first heartbeat.
      for (let i = 0; i < 50 && !heartbeatObserved; i++) {
        await Promise.resolve();
      }
      expect(heartbeatObserved).toBe(true);

      // A concurrent caller arriving while the first heartbeat is in flight must
      // NOT short-circuit on the `connected` fast path before ownership is recorded.
      let concurrentResolved = false;
      const concurrentConnect = proxy.ensureConnected().then(() => {
        concurrentResolved = true;
      });

      // Give any (incorrect) fast-path resolution a chance to land.
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
      expect(concurrentResolved).toBe(false);
      expect(sessionManager.getSession(BOUND_SESSION)?.hasReceivedHeartbeat).toBe(false);

      released.resolve();
      await Promise.all([firstConnect, concurrentConnect]);
      expect(concurrentResolved).toBe(true);
      expect(sessionManager.getSession(BOUND_SESSION)?.hasReceivedHeartbeat).toBe(true);
    } finally {
      released.resolve();
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  // issue #5643 (close race): because the `connected` flip is deferred until after
  // the awaited first heartbeat, a close() landing DURING that round-trip must not be
  // undone. doConnect() re-checks `closing` before the flip, so the proxy stays
  // disconnected instead of resuming with a stale connected flag over a nulled client.
  test("does not resurrect the connected flag when close() lands during the first heartbeat", async () => {
    await sessionManager.createSession(BOUND_SESSION, "emulator-5554", "android", 60_000);

    const released = Promise.withResolvers<void>();
    let heartbeatObserved = false;
    const fakeClient = new FakeDaemonClient({
      onCallDaemonMethod: async (method, params) => {
        if (method === "daemon/heartbeat" && typeof params.sessionId === "string") {
          heartbeatObserved = true;
          await released.promise;
          sessionManager.recordHeartbeat(params.sessionId);
        }
      },
    });
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      initialSessionUuid: BOUND_SESSION,
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
    });

    try {
      // The establishing caller rejects when close() tears down the connection; the
      // detached doConnect() must still not flip connected=true afterwards.
      const connectResult = proxy.ensureConnected().then(
        () => "resolved",
        () => "rejected",
      );

      for (let i = 0; i < 50 && !heartbeatObserved; i++) {
        await Promise.resolve();
      }
      expect(heartbeatObserved).toBe(true);

      // Close while the first heartbeat is still gated in flight.
      const closed = proxy.close();
      released.resolve();
      await closed;
      expect(await connectResult).toBe("rejected");

      // The flag must reflect the close, not the resumed establishment.
      expect(proxy.isConnected()).toBe(false);
    } finally {
      released.resolve();
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  // AC3: connection establishment delivers exactly one first heartbeat — a
  // reconnect must not compound duplicates onto a fresh transport.
  test("delivers exactly one heartbeat on a single establishment", async () => {
    await sessionManager.createSession(BOUND_SESSION, "emulator-5554", "android", 60_000);

    const fakeClient = heartbeatForwardingClient(sessionManager);
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      initialSessionUuid: BOUND_SESSION,
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
    });

    try {
      await proxy.ensureConnected();
      const heartbeats = fakeClient.callDaemonMethodCalls.filter(
        (call) => call.method === "daemon/heartbeat",
      );
      expect(heartbeats).toEqual([
        { method: "daemon/heartbeat", params: { sessionId: BOUND_SESSION } },
      ]);
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  // AC3: a terminally released session is never resurrected by an establishment
  // heartbeat, and shutdown emits no further heartbeats.
  test("does not resurrect a terminally released session on establishment", async () => {
    await sessionManager.createSession(BOUND_SESSION, "emulator-5554", "android", 60_000);

    const fakeClient = heartbeatForwardingClient(sessionManager);
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      initialSessionUuid: BOUND_SESSION,
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
    });

    try {
      await proxy.ensureConnected();
      // The daemon terminally releases the bound session.
      fakeClient.emitNotification(
        SESSION_RELEASED_NOTIFICATION_METHOD,
        BOUND_SESSION,
        "heartbeat-timeout",
      );

      const heartbeatsBefore = fakeClient.callDaemonMethodCalls.filter(
        (call) => call.method === "daemon/heartbeat",
      ).length;

      // Any further work throws the terminal fence rather than re-binding.
      await expect(proxy.callTool("observe", { deviceId: "device-a" })).rejects.toThrow();

      const heartbeatsAfter = fakeClient.callDaemonMethodCalls.filter(
        (call) => call.method === "daemon/heartbeat",
      ).length;
      expect(heartbeatsAfter).toBe(heartbeatsBefore);
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  // AC3: a session-released notification landing DURING the establishment
  // heartbeat must terminally fence the binding without leaving a leaked keeper
  // interval running against the fenced session.
  test("does not start the keeper when the session is released mid-establishment", async () => {
    await sessionManager.createSession(BOUND_SESSION, "emulator-5554", "android", 60_000);

    const released = Promise.withResolvers<void>();
    const clientRef: { current: FakeDaemonClient | null } = { current: null };
    const fakeClient = new FakeDaemonClient({
      onCallDaemonMethod: async (method) => {
        if (method === "daemon/heartbeat") {
          // The daemon terminally releases the session while the first heartbeat
          // is still in flight.
          clientRef.current!.emitNotification(
            SESSION_RELEASED_NOTIFICATION_METHOD,
            BOUND_SESSION,
            "heartbeat-timeout",
          );
          await released.promise;
        }
      },
    });
    clientRef.current = fakeClient;
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      initialSessionUuid: BOUND_SESSION,
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
    });

    const pendingBefore = timer.getPendingIntervalCount();
    try {
      const connectPromise = proxy.ensureConnected();
      // Let establishment reach the gated heartbeat (and thus the release).
      for (let i = 0; i < 50; i++) {
        await Promise.resolve();
      }
      released.resolve();
      await connectPromise;

      // The keeper must not have been (re)started against the fenced session.
      expect(timer.getPendingIntervalCount()).toBe(pendingBefore);
      // Any further work throws the terminal fence rather than heartbeating.
      await expect(proxy.callTool("observe", { deviceId: "device-a" })).rejects.toThrow();
    } finally {
      released.resolve();
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  // AC3: a keeper-driven reconnect (the recurring heartbeat itself hitting a
  // stale transport) must not compound a duplicate heartbeat onto the fresh
  // transport — the reconnect defers to the keeper's own coalescing run().
  test("does not duplicate the heartbeat on a keeper-driven reconnect", async () => {
    await sessionManager.createSession(BOUND_SESSION, "emulator-5554", "android", 60_000);

    let staleHeartbeats = 0;
    const staleClient = new FakeDaemonClient({
      onCallDaemonMethod: async (method, params) => {
        if (method === "daemon/heartbeat" && typeof params.sessionId === "string") {
          staleHeartbeats += 1;
          if (staleHeartbeats === 1) {
            // Establishment heartbeat succeeds.
            sessionManager.recordHeartbeat(params.sessionId);
            return;
          }
          // The keeper's next tick finds the transport gone, forcing a reconnect.
          throw new DaemonUnavailableError("Daemon socket connection lost");
        }
      },
    });
    const freshClient = heartbeatForwardingClient(sessionManager);
    const clients: DaemonClientLike[] = [staleClient, freshClient];
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      initialSessionUuid: BOUND_SESSION,
      clientFactory: () => clients.shift()!,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
    });

    try {
      await proxy.ensureConnected();
      // Drive the keeper's first tick (default interval 2s), which fails on the
      // stale client and reconnects to the fresh one.
      await timer.advanceTimeAsync(2_000);

      const freshHeartbeats = freshClient.callDaemonMethodCalls.filter(
        (call) => call.method === "daemon/heartbeat",
      );
      // Exactly one on the fresh transport: the reconnect coalesces with the
      // in-flight keeper tick instead of adding an establishment heartbeat.
      expect(freshHeartbeats).toEqual([
        { method: "daemon/heartbeat", params: { sessionId: BOUND_SESSION } },
      ]);
      expect(sessionManager.getSession(BOUND_SESSION)).not.toBeNull();
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  // AC1: the ownership heartbeat is delivered before the best-effort notification
  // subscription — subscribeToNotifications() is a daemon RPC that can stall, and
  // must not delay the time-critical first heartbeat past the reclaim grace.
  test("delivers the first heartbeat before subscribing to notifications", async () => {
    await sessionManager.createSession(BOUND_SESSION, "emulator-5554", "android", 60_000);

    let subscribeCallsAtHeartbeat = -1;
    const clientRef: { current: FakeDaemonClient | null } = { current: null };
    const fakeClient = new FakeDaemonClient({
      onCallDaemonMethod: (method, params) => {
        if (method === "daemon/heartbeat" && typeof params.sessionId === "string") {
          subscribeCallsAtHeartbeat = clientRef.current!.subscribeToNotificationsCalls;
          sessionManager.recordHeartbeat(params.sessionId);
        }
      },
    });
    clientRef.current = fakeClient;
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      initialSessionUuid: BOUND_SESSION,
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
    });

    try {
      await proxy.ensureConnected();
      // The heartbeat ran while the subscription had not yet been requested.
      expect(subscribeCallsAtHeartbeat).toBe(0);
      // The subscription still happens (best-effort), just after the heartbeat.
      expect(fakeClient.subscribeToNotificationsCalls).toBe(1);
      expect(sessionManager.getSession(BOUND_SESSION)?.hasReceivedHeartbeat).toBe(true);
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  // AC3 (terminal fencing intact): if the first heartbeat comes back
  // "Session not found" — the bound session was reaped before it arrived — the
  // binding is terminally fenced rather than silently proceeding, and no keeper
  // interval is left running.
  test("fences the binding when the first heartbeat reports the session is gone", async () => {
    // Deliberately do NOT create the session, so the daemon reports it missing.
    const fakeClient = new FakeDaemonClient({
      onCallDaemonMethod: (method) => {
        if (method === "daemon/heartbeat") {
          throw new Error("Session not found: " + BOUND_SESSION);
        }
      },
    });
    const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const proxy = new DaemonMcpProxy({
      initialSessionUuid: BOUND_SESSION,
      clientFactory: () => fakeClient,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
    });

    const pendingBefore = timer.getPendingIntervalCount();
    try {
      // Establishment resolves (it does not throw), but the binding is now terminal.
      await proxy.ensureConnected();

      expect(timer.getPendingIntervalCount()).toBe(pendingBefore);
      // The next operation surfaces the terminal ownership loss.
      await expect(proxy.callTool("observe", { deviceId: "device-a" })).rejects.toThrow();
    } finally {
      isAvailableSpy.mockRestore();
      await proxy.close();
    }
  });

  // AC4: a bound session whose proxy never connects still expires under the
  // existing pre-first-heartbeat reclaim policy from #2443.
  test("still expires a bound session whose proxy never connects", async () => {
    await sessionManager.createSession(BOUND_SESSION, "emulator-5554", "android", 60_000);

    // No proxy ever connects: past the pre-first-heartbeat grace, the session is
    // reaped exactly as the existing cleanup policy dictates.
    timer.advanceTime(5_001);
    await monitor.tick();

    expect(reaped).toEqual([{ sessionId: BOUND_SESSION, reason: "missing-first-heartbeat" }]);
    expect(sessionManager.getSession(BOUND_SESSION)).toBeNull();
  });
});
