import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DAEMON_HEARTBEAT_METHOD, DAEMON_VERSION } from "../../src/daemon/constants";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import type { LivenessHandover } from "../../src/daemon/proxyLivenessRecovery";
import { logger } from "../../src/utils/logger";
import type { Timer } from "../../src/utils/SystemTimer";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { readyManagedSlotsResult } from "../helpers/refusalWireFixtures";
import type { ManagedSlotsResult } from "../../src/models/managedSlotsResult";

// #11483 item 1 (stdio proxy contract): a MANAGED connection whose execution session the daemon released
// for a lost heartbeat while the proxy itself was stalled (host sleep, SIGSTOP, a long GC pause).
// The proxy's stall recovery learns the session is gone and reports it as `proxy_stalled` with
// `recovery.action: "reacquire_lost_sessions"`, `retryable: true` and "Reacquire the devices with
// getAndroid or getApple" - the advice #11341/#11471 removed for every other terminal release of a
// managed session, because a managed connection always refuses getAndroid/getApple. The contract:
// a managed connection answers a terminally released execution session with
// `managed_execution_ended` (retryable false, nextAction relaunch_execution), never with advice to
// acquire a device. The harness mirrors test/daemon/proxyLivenessStalls.test.ts (real session
// manager and heartbeat handler behind the fake daemon client, a stallable clock) and
// test/daemon/proxyManagedExecutionHold.test.ts (the managed hold).
//
// Every assertion is on what the proxy server answers and pushes, so the file imports nothing the
// fix added and fails on the pre-fix tree for the behaviour, not for a missing export.

const SESSION = "11111111-2222-4333-8444-555555555555";
const LEASE_MS = 10_000;
const INTERVAL_MS = 2_000;

class LivenessTimer extends FakeTimer {
  override advanceTimeAsync(ms: number): Promise<void> {
    return super.advanceTimeAsync(ms, () => drainUntilQuiescent(this));
  }
}

/** A fake timer whose clock a test can push ahead without firing timers: a stalled event loop. */
class StallableTimer implements Timer {
  private skewMs = 0;
  constructor(private readonly base: FakeTimer) {}
  stall(ms: number): void {
    this.skewMs += ms;
  }
  now(): number {
    return this.base.now() + this.skewMs;
  }
  sleep(ms: number): Promise<void> {
    return this.base.sleep(ms);
  }
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    return this.base.setTimeout(callback, ms);
  }
  clearTimeout(handle: NodeJS.Timeout): void {
    this.base.clearTimeout(handle);
  }
  setInterval(callback: () => void, ms: number): NodeJS.Timeout {
    return this.base.setInterval(callback, ms);
  }
  clearInterval(handle: NodeJS.Timeout): void {
    this.base.clearInterval(handle);
  }
}

const extra = {
  signal: new AbortController().signal,
  requestId: 1,
  sendNotification: async () => {},
  sendRequest: async () => {
    throw new Error("Unexpected request");
  },
};

let baseTimer: LivenessTimer;
let timer: StallableTimer;
let sessionManager: SessionManager;
let proxy: DaemonMcpProxy;
let handovers: LivenessHandover[];
let clients: FakeDaemonClient[];
let spies: Array<ReturnType<typeof spyOn>>;

beforeEach(async () => {
  baseTimer = new LivenessTimer();
  timer = new StallableTimer(baseTimer);
  sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  await sessionManager.createSession(SESSION, "emulator-5554", "android", 60_000, LEASE_MS);
  await sessionManager.adoptManagedExecutionLivenessPolicy(SESSION, { idleTimeoutMs: 10 * 60_000 });
  const state: DaemonStateAccess = {
    isInitialized: () => true,
    getSessionManager: () => sessionManager,
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 1, idle: 0, assigned: 1, error: 0 }),
    }),
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  };
  const daemonManager = new FakeDaemonManager();
  daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
  spies = [
    spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
    spyOn(logger, "info").mockImplementation(() => {}),
    spyOn(logger, "warn").mockImplementation(() => {}),
    spyOn(logger, "error").mockImplementation(() => {}),
  ];
  handovers = [];
  clients = [];
  proxy = new DaemonMcpProxy({
    clientFactory: () => {
      const client = new FakeDaemonClient({
        onCallDaemonMethod: async (method, params) => {
          if (method !== DAEMON_HEARTBEAT_METHOD) {
            return undefined;
          }
          const response = await handleDaemonRequest(
            { id: "r", type: "daemon_request", method, params },
            state,
          );
          if (!response.success) {
            throw Object.assign(new Error(response.error), { code: response.code });
          }
          return response.result;
        },
      });
      clients.push(client);
      return client;
    },
    daemonManager,
    autoStartDaemon: false,
    timer,
    idGenerator: new FakeIdGenerator(["managed-proxy-token"]),
    heartbeatTimeoutMs: LEASE_MS,
    heartbeatIntervalMs: INTERVAL_MS,
  });
  proxy.onLivenessHandover((handover) => handovers.push(handover));
});

afterEach(async () => {
  await proxy.close();
  sessionManager.stopCleanupTimer();
  for (const spy of spies) {
    spy.mockRestore();
  }
});

interface ToolAnswer {
  isError?: boolean;
  content: Array<{ text: string }>;
}

/**
 * Lose the held session during a proxy stall on a connection served by the proxy MCP server, then
 * hand the test its tools/call handler and every logging notification the server pushed.
 */
async function withStallLoss(
  managedSlots: ManagedSlotsResult | undefined,
  body: (
    callTool: (name: string, args: Record<string, unknown>) => Promise<ToolAnswer>,
    pushed: () => unknown[],
  ) => Promise<void>,
): Promise<void> {
  const registration = spyOn(Server.prototype, "setRequestHandler");
  const { server } = createProxyMcpServer({ proxy, ...(managedSlots ? { managedSlots } : {}) });
  const handler = registration.mock.calls.find(([schema]) => schema === CallToolRequestSchema)?.[1];
  registration.mockRestore();
  const logged = spyOn(Server.prototype, "sendLoggingMessage").mockResolvedValue(undefined);
  spies.push(logged);
  if (!handler) {
    throw new Error("Missing tools/call handler");
  }

  try {
    // The session is held: claimed and heartbeated from now on.
    await proxy.holdManagedExecutionSession(SESSION);
    expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBeDefined();

    // The proxy stalls past the lease and the suspect grace; the daemon's heartbeat monitor
    // releases the session terminally meanwhile.
    timer.stall(LEASE_MS + SUSPECT_GRACE_MS + 5_000);
    await sessionManager.releaseSession(SESSION, "heartbeat-timeout");
    await baseTimer.advanceTimeAsync(INTERVAL_MS);
    await baseTimer.advanceTimeAsync(INTERVAL_MS);

    // Precondition: the proxy's own recovery classified this as a definitive loss.
    expect(handovers.map((handover) => handover.code)).toEqual(["proxy_stalled"]);

    await body(
      async (name, args) =>
        (await handler(
          { method: "tools/call", params: { name, arguments: args } },
          extra,
        )) as ToolAnswer,
      () => logged.mock.calls.map(([params]) => params.data),
    );
  } finally {
    await server.close();
  }
}

/** The read after the stall answer reached the daemon, and carried no session. */
async function expectNextReadForwardedSessionless(
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolAnswer>,
): Promise<void> {
  const forwarded = () => clients.flatMap((client) => client.callToolCalls);
  expect(forwarded()).toEqual([]);
  const read = await callTool("observe", { deviceId: "emulator-5554" });
  expect(read.isError).not.toBe(true);
  expect(forwarded()).toEqual([{ toolName: "observe", params: { deviceId: "emulator-5554" } }]);
}

test("a managed connection answers a session lost during a proxy stall with managed_execution_ended, not proxy_stalled reacquire advice", async () => {
  await withStallLoss(readyManagedSlotsResult(SESSION), async (callTool, pushed) => {
    const result = await callTool("tapOn", { text: "OK" });
    const text = result.content[0].text;
    const error = JSON.parse(text).error;

    expect(result.isError).toBe(true);
    expect(error).toMatchObject({
      code: "managed_execution_ended",
      retryable: false,
      nextAction: "relaunch_execution",
      sessionUuid: SESSION,
    });
    expect(text).not.toContain("getAndroid");
    expect(text).not.toContain("getApple");
    expect(error).not.toHaveProperty("recovery");

    // The pushed logging notification carries the same answer, not the reacquire advice.
    expect(pushed()).toEqual([{ error }]);

    // That answer told the caller once: it is not refused a second time before reads go through.
    await expectNextReadForwardedSessionless(callTool);
  });
});

test("a generic connection keeps the proxy_stalled answer for the same loss, and is told once", async () => {
  await withStallLoss(undefined, async (callTool, pushed) => {
    const result = await callTool("tapOn", { text: "OK" });
    const error = JSON.parse(result.content[0].text).error;

    expect(result.isError).toBe(true);
    expect(error).toMatchObject({
      code: "proxy_stalled",
      retryable: true,
      recovery: { action: "reacquire_lost_sessions" },
    });
    expect(error.sessions.map((session: { sessionUuid: string }) => session.sessionUuid)).toEqual([
      SESSION,
    ]);
    expect(pushed()).toEqual([{ error }]);

    await expectNextReadForwardedSessionless(callTool);
  });
});
