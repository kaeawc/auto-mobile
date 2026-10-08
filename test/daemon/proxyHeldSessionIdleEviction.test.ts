import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

// Issue #10657 (child of #10655): a held session no tool call names for the idle window is
// abandoned and the proxy stops heartbeating it. Issue #9335 (child of #10049): a proxy owns liveness for every device session it
// holds, not only its latest binding. `boundSessionUuid` moves to the newest
// session on each acquisition, so the earlier sessions used to receive no
// heartbeat and were reaped with `heartbeat-timeout` while the proxy was healthy.

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

  /** Heartbeat session ids sent by the next keeper tick only. */
  async function tickSessions(): Promise<string[]> {
    const before = heartbeats().length;
    await timer.advanceTimeAsync(INTERVAL_MS);
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

  const IDLE_WINDOW_MS = 30 * 60 * 1000;

  test("stops heartbeating a superseded device after the idle window while the new one keeps going", async () => {
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");
    expect(await tickSessions()).toEqual(["android-session", "ios-session"]);

    await timer.advanceTimeAsync(IDLE_WINDOW_MS);

    expect(await tickSessions()).toEqual(["ios-session"]);
    expect(await tickSessions()).toEqual(["ios-session"]);
  });

  test("keeps both devices heartbeating while each was used within the idle window", async () => {
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");
    await timer.advanceTimeAsync(IDLE_WINDOW_MS - 10 * 60 * 1000);
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");

    await timer.advanceTimeAsync(15 * 60 * 1000);

    expect(await tickSessions()).toEqual(["android-session", "ios-session"]);
  });

  test("idles the keeper's held set once every abandoned session is evicted", async () => {
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");
    client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, "ios-session", "device-killed");
    await timer.advanceTimeAsync(IDLE_WINDOW_MS);

    expect(await tickSessions()).toEqual([]);
  });
});
