import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { DAEMON_BOUND_SESSION_REPLAY_TTL_MS, DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

// Issue #10657 (child of #10655): a held session no tool call names for the idle window is
// abandoned and the proxy stops heartbeating it. Issue #9335 (child of #10049): a proxy owns liveness for every device session it
// holds, not only its latest binding. `boundSessionUuid` moves to the newest
// session on each acquisition, so the earlier sessions used to receive no
// heartbeat and were reaped with `heartbeat-timeout` while the proxy was healthy.

/** Microtask turns for one keeper round trip to settle before the next tick. */
const KEEPER_TURNS = 32;
const INTERVAL_MS = 2_000;
const TIMEOUT_MS = 10_000;

function matchingDaemonManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
}

function deviceStartResult(sessionUuid: string): {
  content: Array<{ type: string; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify({ runtime: { session: { sessionUuid } } }) }],
  };
}

interface HeartbeatCall {
  sessionId: string;
  claimLivenessOwnership: boolean;
  livenessOwnerToken: string;
}

describe("proxy stops heartbeating held sessions the conversation abandoned (issue #10657)", () => {
  let timer: FakeTimer;
  let client: FakeDaemonClient;
  let failHeartbeatFor: Set<string>;
  let mintedBy: Record<string, string>;
  let proxy: DaemonMcpProxy;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;

  function createProxy(initialSessionUuid?: string): DaemonMcpProxy {
    return new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(),
      heartbeatTimeoutMs: TIMEOUT_MS,
      heartbeatIntervalMs: INTERVAL_MS,
      ...(initialSessionUuid ? { initialSessionUuid } : {}),
    });
  }

  function heartbeats(): HeartbeatCall[] {
    return client.callDaemonMethodCalls
      .filter((call) => call.method === "daemon/heartbeat")
      .map((call) => ({
        sessionId: call.params.sessionId,
        claimLivenessOwnership: call.params.claimLivenessOwnership === true,
        livenessOwnerToken: call.params.livenessOwnerToken,
      }));
  }

  /**
   * Advance fake time, settling each keeper round trip on microtasks. The default per-event
   * real event-loop turn made a 2-minute advance (60 ticks) cost 60 turns, which pushed the
   * longest tests of this file toward the 100 ms unit budget (#10705).
   */
  const advance = (ms: number): Promise<void> =>
    timer.advanceTimeAsync(ms, () => drainMicrotasks(KEEPER_TURNS));

  /** Heartbeat session ids sent by the next keeper tick only. */
  async function tickSessions(): Promise<string[]> {
    const before = heartbeats().length;
    await advance(INTERVAL_MS);
    return heartbeats()
      .slice(before)
      .map((call) => call.sessionId)
      .sort();
  }

  async function acquire(tool: "getAndroid" | "getApple", sessionUuid: string): Promise<void> {
    mintedBy[tool] = sessionUuid;
    await proxy.callTool(tool, {});
  }

  beforeEach(() => {
    timer = new FakeTimer();
    failHeartbeatFor = new Set();
    mintedBy = {};
    client = new FakeDaemonClient({
      toolResultFor: (name) => (mintedBy[name] ? deviceStartResult(mintedBy[name]) : undefined),
      onCallDaemonMethod: (method, params) => {
        if (method === "daemon/heartbeat" && failHeartbeatFor.has(params.sessionId)) {
          throw new Error(`heartbeat rejected for ${params.sessionId}`);
        }
      },
    });
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    proxy = createProxy();
  });

  afterEach(async () => {
    await proxy.close();
    isAvailableSpy.mockRestore();
    warnSpy.mockRestore();
  });

  const IDLE_WINDOW_MS = DAEMON_BOUND_SESSION_REPLAY_TTL_MS;

  test("stops heartbeating a superseded device after the idle window while the new one keeps going", async () => {
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");
    expect(await tickSessions()).toEqual(["android-session", "ios-session"]);

    // The conversation keeps using only the new device.
    await advance(IDLE_WINDOW_MS / 2);
    await proxy.callTool("observe", {});
    await advance(IDLE_WINDOW_MS / 2);

    expect(await tickSessions()).toEqual(["ios-session"]);
    expect(await tickSessions()).toEqual(["ios-session"]);
  });

  test("keeps both devices heartbeating while each was used within the idle window", async () => {
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");
    await advance(IDLE_WINDOW_MS / 2);
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");

    // Past the window measured from the first acquisition, inside it from the second.
    await advance((IDLE_WINDOW_MS * 3) / 4);

    expect(await tickSessions()).toEqual(["android-session", "ios-session"]);
  });

  test("idles the keeper's held set once every abandoned session is evicted", async () => {
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");
    client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, "ios-session", "device-killed");
    await advance(IDLE_WINDOW_MS);

    expect(await tickSessions()).toEqual([]);
  });
});
