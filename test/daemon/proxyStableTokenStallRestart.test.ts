import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client/client";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import {
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
  DAEMON_VERSION,
} from "../../src/daemon/wire/constants";
import {
  DAEMON_RESTART_RESUMED_CODE,
  type LivenessHandover,
} from "../../src/daemon/proxyLivenessRecovery";
import { DAEMON_INSTANCE_CHANGED_CODE } from "../../src/daemon/types";
import { DaemonUnavailableError } from "../../src/daemon/client/client";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent, settleByFakeEvents } from "../helpers/fakeTimerStepping";
import { logger } from "../../src/utils/logger";

// #11018: a proxy with a stable owner token (#10990) whose daemon stalls past recovery (#10989)
// and is then restarted by the harness. The stall probe's reconnect runs the token resume against
// the new daemon, which restored the token's sessions; reconnect must leave handed-over sessions
// to the pinned probe. Only its instance-change refusal permits an unpinned owner claim.

class LivenessTimer extends FakeTimer {
  override advanceTimeAsync(ms: number): Promise<void> {
    return super.advanceTimeAsync(ms, () => drainUntilQuiescent(this));
  }
}

const TOKEN = "harness-stable-token";
const LEASE_MS = 4_000;
const INTERVAL_MS = 2_000;
const BOUND = "ios-session";
const HELD = "android-session";
const DEVICES: Record<string, string> = { [HELD]: "emulator-5554", [BOUND]: "sim-1" };

function warnings(result: unknown): Array<Record<string, unknown>> {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.flatMap((block) => {
    try {
      const parsed = JSON.parse(block.text ?? "") as { warning?: Record<string, unknown> };
      return parsed.warning ? [parsed.warning] : [];
    } catch {
      return [];
    }
  });
}

describe("stable-token resume after a daemon stall and restart (#11018)", () => {
  let timer: LivenessTimer;
  let sessionManager: SessionManager;
  let daemonInstance: string;
  let stalled: boolean;
  let pendingWhileStalled: Array<(error: Error) => void>;
  let clients: FakeDaemonClient[];
  /** Every heartbeat and resume listing, with the daemon process it reached. */
  let daemonCalls: Array<{ daemon: string; method: string; params: Record<string, unknown> }>;
  let refusals: string[];
  let handovers: LivenessHandover[];
  let spies: Array<ReturnType<typeof spyOn>>;
  let proxy: DaemonMcpProxy;

  beforeAll(async () => {
    // Warm a separate fake connection; each scenario still owns a fresh proxy and sessions.
    const warmTimer = new LivenessTimer();
    const warmManager = new FakeDaemonManager();
    warmManager.statusResult = { ...warmManager.statusResult, version: DAEMON_VERSION };
    const warmProxy = new DaemonMcpProxy({
      livenessOwnerToken: "warm-stable-token",
      clientFactory: () =>
        new FakeDaemonClient({
          daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
          toolResultFor: (name) => ({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  runtime: {
                    deviceId: `warm-${name}-device`,
                    session: { sessionUuid: `warm-${name}-session` },
                  },
                }),
              },
            ],
          }),
        }),
      daemonManager: warmManager,
      autoStartDaemon: false,
      daemonAvailabilityProbe: async () => true,
      timer: warmTimer,
      heartbeatTimeoutMs: LEASE_MS,
      heartbeatIntervalMs: INTERVAL_MS,
    });
    try {
      await warmProxy.callTool("getAndroid", {});
      await warmProxy.callTool("getApple", {});
      await warmTimer.advanceTimeAsync(INTERVAL_MS * 2);
    } finally {
      await warmProxy.close();
    }
  });

  function daemonState(): DaemonStateAccess {
    return {
      isInitialized: () => true,
      getDaemonInstance: () => daemonInstance,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        releaseDevice: async () => {},
        getStats: () => ({ total: 2, idle: 0, assigned: 2, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    } as DaemonStateAccess;
  }

  async function daemonCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    const response = await handleDaemonRequest(
      { id: "r", type: "daemon_request", method, params },
      daemonState(),
    );
    if (!response.success) {
      if (typeof response.code === "string") {
        refusals.push(response.code);
      }
      throw Object.assign(new Error(response.error), response);
    }
    return response.result;
  }

  function daemonClient(): FakeDaemonClient {
    const client = new FakeDaemonClient({
      daemonMethodResults: new Map<string, unknown>([["tools/list", { tools: [] }]]),
      toolResultFor: (name, params) =>
        name === "getAndroid" || name === "getApple"
          ? {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    runtime: {
                      deviceId: DEVICES[name === "getAndroid" ? HELD : BOUND],
                      session: { sessionUuid: name === "getAndroid" ? HELD : BOUND },
                    },
                  }),
                },
              ],
            }
          : { content: [{ type: "text", text: JSON.stringify({ observed: params.sessionUuid }) }] },
      onCallDaemonMethod: (method, params) => {
        if (method !== DAEMON_HEARTBEAT_METHOD && method !== DAEMON_TOKEN_OWNED_SESSIONS_METHOD) {
          return undefined;
        }
        daemonCalls.push({ daemon: daemonInstance, method, params });
        if (stalled) {
          // The frozen daemon never answers; its socket drops when the harness kills it.
          return new Promise((_resolve, reject) => pendingWhileStalled.push(reject));
        }
        return daemonCall(method, params);
      },
    });
    clients.push(client);
    return client;
  }

  async function seedSessions(): Promise<void> {
    for (const [sessionId, deviceId] of Object.entries(DEVICES)) {
      await sessionManager.createSession(
        sessionId,
        deviceId,
        sessionId === BOUND ? "ios" : "android",
        { timeoutMs: 60_000, heartbeatTimeoutMs: LEASE_MS },
      );
    }
  }

  async function advance(ms: number): Promise<void> {
    await timer.advanceTimeAsync(ms);
  }

  function heartbeatsTo(daemon: string, sessionId: string): Array<Record<string, unknown>> {
    return daemonCalls
      .filter(
        (call) =>
          call.daemon === daemon &&
          call.method === DAEMON_HEARTBEAT_METHOD &&
          call.params.sessionId === sessionId,
      )
      .map((call) => call.params);
  }

  beforeEach(async () => {
    timer = new LivenessTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    await seedSessions();
    daemonInstance = "daemon-1";
    stalled = false;
    pendingWhileStalled = [];
    clients = [];
    daemonCalls = [];
    refusals = [];
    handovers = [];
    spies = [
      spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
      spyOn(logger, "debug").mockImplementation(() => {}),
    ];
    const manager = new FakeDaemonManager();
    manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
    proxy = new DaemonMcpProxy({
      livenessOwnerToken: TOKEN,
      clientFactory: () => daemonClient(),
      daemonManager: manager,
      autoStartDaemon: false,
      timer,
      heartbeatTimeoutMs: LEASE_MS,
      heartbeatIntervalMs: INTERVAL_MS,
    });
    proxy.onLivenessHandover((handover) => handovers.push(handover));
  });

  afterEach(async () => {
    stalled = false;
    await proxy.close();
    sessionManager.stopCleanupTimer();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  /** The harness kills the stalled daemon and starts a new one that restored both sessions. */
  async function restartDaemon(): Promise<void> {
    sessionManager.stopCleanupTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    await seedSessions();
    daemonInstance = "daemon-2";
    // Restored from the database still owned by the stable token.
    for (const sessionId of Object.keys(DEVICES)) {
      await daemonCall(DAEMON_HEARTBEAT_METHOD, {
        sessionId,
        livenessOwnerToken: TOKEN,
        claimLivenessOwnership: true,
      });
    }
    stalled = false;
    for (const reject of pendingWhileStalled.splice(0)) {
      reject(new DaemonUnavailableError("Daemon connection closed"));
    }
    for (const client of clients) {
      client.emitConnectionClosed();
    }
  }

  test("reconnect leaves handed-over sessions pinned; the restart probe reclaims them and warns once", async () => {
    await proxy.callTool("getAndroid", {});
    await proxy.callTool("getApple", {});
    await advance(INTERVAL_MS * 2);

    stalled = true;
    await settleByFakeEvents(
      timer,
      new Promise<LivenessHandover>((resolve) => proxy.onLivenessHandover(resolve)),
      { description: "stable-token daemon stall handover" },
    );
    expect(handovers.map((handover) => handover.code)).toEqual(["daemon_stalled"]);
    expect(handovers[0].sessions.map((session) => session.sessionUuid).sort()).toEqual(
      [BOUND, HELD].sort(),
    );

    await restartDaemon();
    const ownerHeartbeatAtRestart = sessionManager.getSession(HELD)!.lastOwnerHeartbeat;
    if (ownerHeartbeatAtRestart === undefined) {
      throw new Error("the held session has recorded no owner heartbeat");
    }
    await advance(INTERVAL_MS * 2);

    // #11018: token resume on reconnect must not adopt before the pinned probe is refused.
    const toRestarted = heartbeatsTo("daemon-2", HELD);
    expect(toRestarted.length).toBeGreaterThan(0);
    for (const sessionId of [BOUND, HELD]) {
      const beats = heartbeatsTo("daemon-2", sessionId);
      expect(beats[0]).toMatchObject({ expectedDaemonInstance: "daemon-1" });
      expect(beats[0].claimLivenessOwnership).not.toBe(true);
      expect(beats[1]).toMatchObject({ claimLivenessOwnership: true });
      expect(beats[1]).not.toHaveProperty("expectedDaemonInstance");
    }
    expect(refusals).toContain(DAEMON_INSTANCE_CHANGED_CODE);
    expect(
      daemonCalls.some(
        (call) => call.daemon === "daemon-2" && call.method === DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
      ),
    ).toBe(true);
    expect(sessionManager.getSession(HELD)!.lastOwnerHeartbeat).toBeGreaterThan(
      ownerHeartbeatAtRestart,
    );
    expect(handovers).toHaveLength(1);

    // The session is already held again: its first named call says so once.
    const first = await proxy.callTool("observe", { sessionUuid: HELD });
    expect((first as { isError?: boolean }).isError).toBeFalsy();
    // The restarted daemon acknowledged the resume, so the notice says the daemon was restarted
    // and state may have been rebuilt, not that nothing needs restarting.
    expect(warnings(first)).toEqual([
      expect.objectContaining({
        code: DAEMON_RESTART_RESUMED_CODE,
        sessionUuid: HELD,
        deviceId: DEVICES[HELD],
        handedOverCode: "daemon_stalled",
        previousDaemonInstance: "daemon-1",
        daemonInstance: "daemon-2",
      }),
    ]);
    expect(String(warnings(first)[0].message)).toContain("restarted");
    expect(String(warnings(first)[0].message)).not.toContain("nothing needs restarting");
    const second = await proxy.callTool("observe", { sessionUuid: HELD });
    expect(warnings(second)).toEqual([]);
  });
});
