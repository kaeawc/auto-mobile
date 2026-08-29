import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";

// Issue #5689: `getAndroid` / `getApple` / `startDevice` mint a device session in
// the tool RESULT. The proxy only ever bound a session from a call's request
// args, so a result-minted session was never bound or heartbeated — the daemon
// reaped it after the pre-first-heartbeat grace, and the first later reference to
// the dead id fenced the connection permanently, including re-acquisition.

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

function matchingDaemonManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
}

function deviceStartResult(sessionUuid: string): {
  content: Array<{ type: string; text: string }>;
} {
  // Acquisition tools emit `sessionUuid` (#5870); mirror the production shape so
  // this exercises the primary read, not the legacy `sessionId` fallback.
  return { content: [{ type: "text", text: JSON.stringify({ sessionUuid }) }] };
}

// A FakeDaemonClient standing in for a daemon that mints a fresh device session
// on each getAndroid call (recorded in a real SessionManager), returns its id in
// the RESULT, and forwards daemon/heartbeat to the same SessionManager.
function acquiringClient(
  sessionManager: SessionManager,
  mintedIds: string[],
): { client: FakeDaemonClient; nextIndex: () => number } {
  let acquired = 0;
  const client = new FakeDaemonClient({
    onCallTool: async (toolName) => {
      if (toolName === "getAndroid") {
        const sessionId = mintedIds[acquired];
        acquired += 1;
        await sessionManager.createSession(sessionId, "emulator-5554", "android", 60_000);
      }
    },
    toolResultFor: (toolName) =>
      toolName === "getAndroid" ? deviceStartResult(mintedIds[acquired - 1]) : undefined,
    onCallDaemonMethod: (method, params) => {
      if (method === "daemon/heartbeat" && typeof params.sessionId === "string") {
        sessionManager.recordHeartbeat(params.sessionId);
      }
    },
  });
  return { client, nextIndex: () => acquired };
}

describe("proxy binds and heartbeats a result-minted device session (issue #5689)", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let reaped: Array<{ sessionId: string; reason: string }>;
  let monitor: SessionHeartbeatMonitor;
  let isAvailableSpy: ReturnType<typeof spyOn> | null;

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
        await sessionManager.releaseSession(sessionId, reason);
      },
      timer,
    );
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  });

  afterEach(async () => {
    await monitor.stop();
    sessionManager.stopCleanupTimer();
    isAvailableSpy?.mockRestore();
    isAvailableSpy = null;
    clearHeartbeatEnv();
  });

  // AC1: a getAndroid RESULT-minted session is bound AND heartbeated by the proxy
  // (as src/server/index.ts does on the direct path), so the daemon has recorded
  // ownership and never reaps it under the pre-first-heartbeat grace.
  test("delivers the first heartbeat for a getAndroid result-minted session", async () => {
    const MINTED = "minted-session-a";
    const { client } = acquiringClient(sessionManager, [MINTED]);
    monitor.start();
    const proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
    });

    try {
      const result = await proxy.callTool("getAndroid", { avdName: "am-api34-ga-arm64" });
      expect(result).toEqual(deviceStartResult(MINTED));

      // The guarantee: the daemon has already recorded the first ownership
      // heartbeat for the minted session.
      expect(sessionManager.getSession(MINTED)?.hasReceivedHeartbeat).toBe(true);

      // Past the pre-first-heartbeat grace, the keeper keeps ownership fresh.
      await timer.advanceTimeAsync(20_000);
      await monitor.tick();

      expect(reaped).toEqual([]);
      expect(sessionManager.getSession(MINTED)).not.toBeNull();
    } finally {
      await proxy.close();
    }
  });

  // AC1 (regression of the exact repro): without binding, the minted session is
  // reaped after ~5s idle. With the fix it survives a 20s idle window and a later
  // sessionless call still routes to it.
  test("a sessionless call after a 20s idle window still reaches the minted session", async () => {
    const MINTED = "minted-session-b";
    const { client } = acquiringClient(sessionManager, [MINTED]);
    monitor.start();
    const proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
    });

    try {
      await proxy.callTool("getAndroid", { avdName: "am-api34-ga-arm64" });
      // Idle 20s, issuing no tool calls (monitor ticks throughout).
      await timer.advanceTimeAsync(20_000);
      await monitor.tick();
      expect(reaped).toEqual([]);

      const observe = await proxy.callTool("observe", { platform: "android", project: "skeleton" });
      expect(observe).toEqual({ content: [{ type: "text", text: "success" }] });
      // The sessionless call routed to the minted session, not a released id.
      expect(client.callToolCalls.at(-1)).toEqual({
        toolName: "observe",
        params: { platform: "android", project: "skeleton", sessionUuid: MINTED },
      });
    } finally {
      await proxy.close();
    }
  });

  // AC2: a terminal fence must NOT fence session acquisition. After the bound
  // session is genuinely released, getAndroid is admitted, mints a fresh session,
  // establishes a new binding, and clears the fence so the connection is usable.
  test("getAndroid is admitted on a fenced connection and re-establishes a binding", async () => {
    const M1 = "minted-session-1";
    const M2 = "minted-session-2";
    const { client } = acquiringClient(sessionManager, [M1, M2]);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
    });

    try {
      await proxy.callTool("getAndroid", { avdName: "am-api34-ga-arm64" });
      // The daemon terminally releases the first minted session.
      client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, M1, "heartbeat-timeout");

      // Re-acquisition is admitted (not fenced) and mints a new session.
      const reacquired = await proxy.callTool("getAndroid", { avdName: "am-api34-ga-arm64" });
      expect(reacquired).toEqual(deviceStartResult(M2));
      expect(sessionManager.getSession(M2)?.hasReceivedHeartbeat).toBe(true);

      // The fence is cleared: a subsequent sessionless call routes to M2.
      await proxy.callTool("observe", { deviceId: "device-a" });
      expect(client.callToolCalls.at(-1)).toEqual({
        toolName: "observe",
        params: { deviceId: "device-a", sessionUuid: M2 },
      });
    } finally {
      await proxy.close();
    }
  });

  // AC3: a sessionless call on a fenced connection whose binding was result-minted
  // (never named by the client) fails naming the CURRENT state — directing to
  // re-acquire — rather than reporting the stale uuid the caller never referenced.
  test("a sessionless call on a result-mint fenced connection names the current state", async () => {
    const M1 = "minted-session-x";
    const { client } = acquiringClient(sessionManager, [M1]);
    const proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
    });

    try {
      await proxy.callTool("getAndroid", { avdName: "am-api34-ga-arm64" });
      client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, M1, "heartbeat-timeout");

      // Sessionless call: the error must direct to re-acquire and must NOT present
      // the stale minted uuid as the caller's own ownership loss.
      const sessionless = proxy.callTool("observe", { deviceId: "device-a" });
      await expect(sessionless).rejects.toThrow(/acquire a new device session/i);
      await expect(sessionless).rejects.not.toThrow(new RegExp(M1));

      // A caller that DOES name the released session still gets ownership-lost.
      await expect(
        proxy.callTool("observe", { sessionUuid: M1, deviceId: "device-a" }),
      ).rejects.toThrow(new RegExp(`${M1}.*(?:expired|released)`, "i"));
    } finally {
      await proxy.close();
    }
  });
});
