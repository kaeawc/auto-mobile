import { withProxyOwnerToken } from "../helpers/proxyOwnerToken";
import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import {
  DaemonMcpProxy,
  RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS,
} from "../../src/daemon/daemonMcpProxy";
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
let stripReleaseReason = false;
let heartbeatSilent = false;
let heartbeats: Array<{ at: number; params: Record<string, unknown> }>;
let firstNotFoundAnswerAt: number | undefined;
let spies: Array<ReturnType<typeof spyOn>>;

const setUp = async (): Promise<void> => {
  stripReleaseReason = false;
  heartbeatSilent = false;
  heartbeats = [];
  firstNotFoundAnswerAt = undefined;
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
          heartbeats.push({ at: timer.now(), params });
          if (heartbeatSilent) {
            return new Promise<never>(() => {});
          }
          const response = await handleDaemonRequest(
            { id: "r", type: "daemon_request", method, params },
            state,
          );
          if (!response.success) {
            firstNotFoundAnswerAt ??= timer.now();
            const refusal = { ...response };
            if (stripReleaseReason) {
              delete refusal.releaseReason;
            }
            throw Object.assign(new Error(response.error), refusal);
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
    initialSessionUuid: SESSION,
  });
  proxy.onLivenessHandover((handover) => handovers.push(handover));
};

const tearDown = async (): Promise<void> => {
  await proxy.close();
  sessionManager.stopCleanupTimer();
  for (const spy of spies) {
    spy.mockRestore();
  }
};

// The first stall-loss run pays the proxy server's one-time module, schema and tool-registry cost
// (over the 100 ms budget on a loaded runner). Pay it once, for both connection kinds, outside the
// timed tests.
beforeAll(async () => {
  for (const managedSlots of [readyManagedSlotsResult(SESSION), undefined]) {
    await setUp();
    try {
      await withStallLoss(managedSlots, async (callTool) => {
        await callTool("tapOn", { text: "OK" });
        await callTool("observe", { deviceId: "emulator-5554" });
      });
    } finally {
      await tearDown();
    }
  }
});

beforeEach(setUp);
afterEach(tearDown);

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
  options: {
    reason?: string;
    stall?: boolean;
    expectHandover?: boolean;
    releaseBeforeStall?: boolean;
  } = {},
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
    if (managedSlots) {
      await proxy.holdManagedExecutionSession(SESSION);
    } else {
      await proxy.ensureConnected();
      expect(proxy.getManagedExecutionSessions()).toEqual([]);
    }
    expect(sessionManager.getSession(SESSION)?.livenessOwnerToken).toBeDefined();

    // The proxy stalls past the lease and the suspect grace; the daemon's heartbeat monitor
    // releases the session terminally meanwhile.
    if (options.releaseBeforeStall) {
      await sessionManager.releaseSession(SESSION, options.reason);
    }
    if (options.stall !== false) {
      timer.stall(LEASE_MS + SUSPECT_GRACE_MS + 5_000);
    }
    if (!options.releaseBeforeStall) {
      await sessionManager.releaseSession(SESSION, options.reason ?? "heartbeat-timeout");
    }
    await baseTimer.advanceTimeAsync(INTERVAL_MS);
    await baseTimer.advanceTimeAsync(INTERVAL_MS);

    // Precondition: the proxy's own recovery classified this as a definitive loss.
    if (options.expectHandover !== false) {
      expect(handovers.map((handover) => handover.code)).toEqual(["proxy_stalled"]);
    }

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
  expect(forwarded()).toEqual([
    {
      toolName: "observe",
      params: withProxyOwnerToken({ deviceId: "emulator-5554" }, "managed-proxy-token"),
    },
  ]);
}

test.each(["heartbeat-timeout", "session-not-found"] as const)(
  "a managed proxy stall reports %s on every call and notification",
  async (reason) => {
    stripReleaseReason = reason === "session-not-found";
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
        reason,
      });
      expect(text).not.toContain("getAndroid");
      expect(text).not.toContain("getApple");
      expect(error).not.toHaveProperty("recovery");

      // The pushed logging notification carries the same answer, not the reacquire advice.
      expect(pushed()).toEqual([{ error }]);

      expect(proxy.getTerminalSessionRelease()).toEqual({ sessionUuid: SESSION, reason });
      const later = await callTool("tapOn", { text: "OK" });
      expect(JSON.parse(later.content[0].text).error).toEqual(error);
      // Reads naming a deviceId still go through, sessionless.
      await expectNextReadForwardedSessionless(callTool);
    });
  },
);

test.each(["heartbeat-timeout", "daemon-restart"])(
  "a generic connection keeps the proxy_stalled answer for %s, and is told once",
  async (reason) => {
    await withStallLoss(
      undefined,
      async (callTool, pushed) => {
        const result = await callTool("tapOn", { text: "OK" });
        const error = JSON.parse(result.content[0].text).error;

        expect(result.isError).toBe(true);
        expect(error).toMatchObject({
          code: "proxy_stalled",
          retryable: true,
          recovery: { action: "reacquire_lost_sessions" },
        });
        expect(
          error.sessions.map((session: { sessionUuid: string }) => session.sessionUuid),
        ).toEqual([SESSION]);
        expect(pushed()).toEqual([{ error }]);

        await expectNextReadForwardedSessionless(callTool);
      },
      { reason },
    );
  },
);

test("PIN: a managed proxy stall ends on device-restart under the daemon's reason", async () => {
  const reason = "device-restart:emulator-5554";
  await withStallLoss(
    readyManagedSlotsResult(SESSION),
    async (callTool, pushed) => {
      expect(proxy.getTerminalSessionRelease()).toEqual({ sessionUuid: SESSION, reason });
      expect(handovers[0].releaseReasons).toEqual({ [SESSION]: reason });
      const result = await callTool("tapOn", { text: "OK" });
      expect(result.isError).toBe(true);
      const error = JSON.parse(result.content[0].text).error;
      expect(error).toMatchObject({ code: "managed_execution_ended", reason, retryable: false });
      expect(pushed()).toEqual([{ error }]);
      const count = heartbeats.length;
      await baseTimer.advanceTimeAsync(INTERVAL_MS * 2);
      expect(heartbeats).toHaveLength(count);
    },
    { reason, releaseBeforeStall: true },
  );
});

test.each(["daemon-restart", "daemon-shutdown"])(
  "a managed proxy stall awaits %s and claims the rehydrated session",
  async (reason) => {
    await withStallLoss(
      readyManagedSlotsResult(SESSION),
      async (callTool, pushed) => {
        expect(handovers).toEqual([]);
        expect(proxy.getTerminalSessionRelease()).toBeUndefined();
        expect(proxy.getManagedExecutionSessions()).toEqual([SESSION]);
        expect(pushed()).toEqual([]);
        const count = heartbeats.length;
        await baseTimer.advanceTimeAsync(INTERVAL_MS * 2);
        expect(heartbeats.slice(count).map(({ params }) => params.claimLivenessOwnership)).toEqual([
          true,
          true,
        ]);

        const session = await sessionManager.createSession(
          SESSION,
          "emulator-5554",
          "android",
          600_000,
          LEASE_MS,
        );
        await sessionManager.adoptManagedExecutionLivenessPolicy(SESSION, {
          idleTimeoutMs: 600_000,
        });
        session.ownership = "awaiting-owner";
        session.awaitingOwnerSince = timer.now();
        await baseTimer.advanceTimeAsync(INTERVAL_MS);
        expect(session.ownership).toBe("owned");
        expect(session.livenessOwnerToken).toBe("managed-proxy-token");
        const result = await callTool("tapOn", { text: "OK" });
        expect(result.isError).not.toBe(true);
        expect(clients.flatMap((client) => client.callToolCalls)).toEqual([
          { toolName: "tapOn", params: { text: "OK", sessionUuid: SESSION } },
        ]);
        expect(handovers).toEqual([]);
        expect(proxy.getTerminalSessionRelease()).toBeUndefined();
        expect(proxy.getManagedExecutionSessions()).toEqual([SESSION]);
        expect(pushed()).toEqual([]);
      },
      { reason, expectHandover: false },
    );
  },
);

async function expiredHandoff(reason: string, stall: boolean) {
  let surface;
  await withStallLoss(
    readyManagedSlotsResult(SESSION),
    async (_callTool, pushed) => {
      expect(firstNotFoundAnswerAt).toBeDefined();
      const firstAnswerAt = firstNotFoundAnswerAt!;
      // A silent socket between not-found answers must not open a second handoff window.
      heartbeatSilent = true;
      await baseTimer.advanceTimeAsync(INTERVAL_MS * 2);
      heartbeatSilent = false;
      await baseTimer.advanceTimeAsync(
        firstAnswerAt + RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS + INTERVAL_MS - timer.now(),
      );
      const count = heartbeats.length;
      expect(count).toBeGreaterThan(2);
      expect(heartbeats.at(-1)!.at - firstAnswerAt).toBeLessThanOrEqual(
        RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS + INTERVAL_MS,
      );
      await baseTimer.advanceTimeAsync(RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS + INTERVAL_MS * 4);
      expect(heartbeats).toHaveLength(count);
      surface = {
        handovers: [...handovers],
        terminalRelease: proxy.getTerminalSessionRelease(),
        managedSessions: proxy.getManagedExecutionSessions(),
        pushed: pushed(),
      };
    },
    { reason, stall, expectHandover: false },
  );
  return surface;
}

test.each(["daemon-restart", "daemon-shutdown"])(
  "a managed proxy stall expires %s exactly like an ordinary keeper, even after silence",
  async (reason) => {
    const stalled = await expiredHandoff(reason, true);
    await tearDown();
    await setUp();
    const ordinary = await expiredHandoff(reason, false);
    expect(stalled).toEqual(ordinary);
    expect(stalled).toMatchObject({ handovers: [], terminalRelease: undefined, pushed: [] });
  },
);
