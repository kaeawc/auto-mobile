import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
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
} from "../../src/daemon/constants";
import {
  DAEMON_STALL_RESUMED_CODE,
  type LivenessHandover,
} from "../../src/daemon/proxyLivenessRecovery";
import { DAEMON_INSTANCE_CHANGED_CODE } from "../../src/daemon/types";
import { DaemonUnavailableError } from "../../src/daemon/client";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { logger } from "../../src/utils/logger";

// #11018: a proxy with a stable owner token (#10990) whose daemon stalls past recovery (#10989)
// and is then restarted by the harness. The stall probe's reconnect runs the token resume against
// the new daemon, which restored the token's sessions; the handed-over sessions must stay the
// pinned probe's or the harness's to resume, not be adopted behind the harness.

class LivenessTimer extends FakeTimer {
  override advanceTimeAsync(ms: number): Promise<void> {
    return super.advanceTimeAsync(ms, () => drainUntilQuiescent(this));
  }
}

const TOKEN = "harness-stable-token";
const LEASE_MS = 4_000;
const INTERVAL_MS = 2_000;
const STOP_MS = 15_000;
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

  function daemonState(): DaemonStateAccess {
    return {
      isInitialized: () => true,
      getDaemonInstance: () => daemonInstance,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
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
      throw Object.assign(new Error(response.error), { code: response.code });
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
        60_000,
        LEASE_MS,
      );
    }
  }

  async function advance(ms: number): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += 250) {
      await timer.advanceTimeAsync(250);
    }
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

  test("handed-over sessions are not adopted on reconnect; naming one resumes it once", async () => {
    await proxy.callTool("getAndroid", {});
    await proxy.callTool("getApple", {});
    await advance(INTERVAL_MS * 2);

    stalled = true;
    for (let elapsed = 0; elapsed < STOP_MS && handovers.length === 0; elapsed += 250) {
      await timer.advanceTimeAsync(250);
    }
    expect(handovers.map((handover) => handover.code)).toEqual(["daemon_stalled"]);
    expect(handovers[0].sessions.map((session) => session.sessionUuid).sort()).toEqual(
      [BOUND, HELD].sort(),
    );

    await restartDaemon();
    const ownerHeartbeatAtRestart = sessionManager.getSession(HELD)!.lastOwnerHeartbeat;
    await advance(LEASE_MS * 5);

    // The probe reconnected to the new daemon and was refused there, pinned to daemon-1...
    const toRestarted = heartbeatsTo("daemon-2", HELD);
    expect(toRestarted.length).toBeGreaterThan(0);
    expect(toRestarted.every((params) => params.expectedDaemonInstance === "daemon-1")).toBe(true);
    expect(refusals).toContain(DAEMON_INSTANCE_CHANGED_CODE);
    expect(
      daemonCalls.some(
        (call) => call.daemon === "daemon-2" && call.method === DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
      ),
    ).toBe(true);
    // ...and nothing claimed or heartbeated the held session behind the harness.
    expect(toRestarted.some((params) => params.claimLivenessOwnership === true)).toBe(false);
    expect(sessionManager.getSession(HELD)!.lastOwnerHeartbeat).toBe(ownerHeartbeatAtRestart);
    expect(heartbeatsTo("daemon-2", BOUND).every((p) => p.expectedDaemonInstance)).toBe(true);
    expect(handovers).toHaveLength(1);

    // The harness names the session: it resumes, and the first call says so once.
    const first = await proxy.callTool("observe", { sessionUuid: HELD });
    expect((first as { isError?: boolean }).isError).toBeFalsy();
    expect(warnings(first)).toEqual([
      expect.objectContaining({ code: DAEMON_STALL_RESUMED_CODE, sessionUuid: HELD }),
    ]);
    const second = await proxy.callTool("observe", { sessionUuid: HELD });
    expect(warnings(second)).toEqual([]);
  });
});
