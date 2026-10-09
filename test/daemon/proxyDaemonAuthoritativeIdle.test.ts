import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_BOUND_SESSION_REPLAY_TTL_MS, DAEMON_VERSION } from "../../src/daemon/constants";
import { withRoutedSessionMeta } from "../../src/server/routedSessionMeta";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

// #10823: the daemon, not the proxy, decides when a session is idle. The proxy's own idle clock
// reads ITS environment and credits calls by the serial it recorded, so either could disagree with
// the daemon and make the proxy stop heartbeating a session the daemon still considered in use.

const INTERVAL_MS = 2_000;
const PROXY_WINDOW_MS = DAEMON_BOUND_SESSION_REPLAY_TTL_MS;
const LONG_DAEMON_WINDOW_MS = PROXY_WINDOW_MS * 5;
const SESSION = "android-session";

function deviceStartResult(): { content: Array<{ type: string; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          platform: "android",
          runtime: { deviceId: "emulator-5554", session: { sessionUuid: SESSION } },
        }),
      },
    ],
  };
}

describe("#10823: the daemon is authoritative for idle release", () => {
  let timer: FakeTimer;
  let client: FakeDaemonClient;
  let proxy: DaemonMcpProxy;
  /** What the fake daemon's heartbeat ack says; empty models a daemon that reports nothing. */
  let daemonMethodResults: Map<string, unknown>;
  let daemonReportsIdleRelease: boolean;
  /** The daemon's own idle window; its acks report the instant this long after the last call. */
  let daemonWindowMs: number;
  /** Heartbeats sent before this time are never answered (an ack gap). */
  let heartbeatGapUntil: number;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let infoSpy: ReturnType<typeof spyOn>;

  const advance = (ms: number): Promise<void> =>
    timer.advanceTimeAsync(ms, () => drainMicrotasks(32));

  function heartbeatCount(): number {
    return client.callDaemonMethodCalls.filter((call) => call.method === "daemon/heartbeat").length;
  }

  /** The daemon's idle window restarts at the end of every tool call. */
  function daemonSawToolCall(): void {
    if (daemonReportsIdleRelease) {
      daemonMethodResults.set("daemon/heartbeat", {
        sessionId: SESSION,
        idleReleaseAt: timer.now() + daemonWindowMs,
      });
    }
  }

  beforeEach(() => {
    timer = new FakeTimer();
    daemonMethodResults = new Map();
    daemonReportsIdleRelease = true;
    daemonWindowMs = LONG_DAEMON_WINDOW_MS;
    heartbeatGapUntil = 0;
    client = new FakeDaemonClient({
      daemonMethodResults,
      onCallDaemonMethod: (method) =>
        method === "daemon/heartbeat" && timer.now() < heartbeatGapUntil
          ? new Promise(() => {})
          : undefined,
      toolResultFor: (name) => {
        daemonSawToolCall();
        return name === "getAndroid"
          ? deviceStartResult()
          : name === "getApple"
            ? {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      platform: "ios",
                      runtime: { deviceId: "SIM-1", session: { sessionUuid: "ios-session" } },
                    }),
                  },
                ],
              }
            : name === "pressButton"
              ? withRoutedSessionMeta({ content: [{ type: "text", text: "ok" }] }, SESSION)
              : undefined;
      },
    });
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager,
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(),
      heartbeatTimeoutMs: 4_000,
      heartbeatIntervalMs: INTERVAL_MS,
    });
  });

  afterEach(async () => {
    await proxy.close();
    isAvailableSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  test("a daemon window longer than the proxy's keeps the session through a pause past the proxy's window", async () => {
    await proxy.callTool("getAndroid", {});
    await advance(PROXY_WINDOW_MS + PROXY_WINDOW_MS / 2);

    await proxy.callTool("observe", {});
    expect(client.callToolCalls.at(-1)).toMatchObject({
      toolName: "observe",
      params: { sessionUuid: SESSION },
    });
    const before = heartbeatCount();
    await advance(INTERVAL_MS * 3);
    expect(heartbeatCount()).toBeGreaterThan(before);
  });

  test("the proxy retires the session once the daemon's own deadline passes", async () => {
    await proxy.callTool("getAndroid", {});
    await advance(daemonWindowMs + INTERVAL_MS * 3);
    await expect(proxy.callTool("observe", {})).rejects.toThrow(/Call getAndroid or getApple/);
    const afterWindow = heartbeatCount();
    await advance(INTERVAL_MS * 10);
    expect(heartbeatCount()).toBe(afterWindow);
  });

  // #10972 P7d: one unanswered heartbeat does not hand idleness back to the proxy's window.
  test("an ack gap past the proxy's window keeps the session the daemon still reports in use", async () => {
    await proxy.callTool("getAndroid", {});
    await advance(PROXY_WINDOW_MS + 30_000);
    // 2:30 into the pause the daemon stops acknowledging heartbeats for 5 s.
    heartbeatGapUntil = timer.now() + 5_000;
    await advance(10_000);

    await proxy.callTool("observe", {});
    expect(client.callToolCalls.at(-1)).toMatchObject({
      toolName: "observe",
      params: { sessionUuid: SESSION },
    });
    const before = heartbeatCount();
    await advance(INTERVAL_MS * 3);
    expect(heartbeatCount()).toBeGreaterThan(before);
  });

  // #10972 P7e: the same for a held session, which the keeper evicts on the local window.
  test("an ack gap does not evict a held session the daemon still reports in use", async () => {
    await proxy.callTool("getAndroid", {});
    await proxy.callTool("getApple", {});
    // Android is held behind the iOS binding; the agent keeps driving iOS only.
    for (let elapsed = 0; elapsed < PROXY_WINDOW_MS + 30_000; elapsed += 30_000) {
      await advance(30_000);
      await proxy.callTool("observe", { sessionUuid: "ios-session" });
    }
    heartbeatGapUntil = timer.now() + 8_000;
    await advance(12_000);

    const heartbeatsFor = (sessionUuid: string) =>
      client.callDaemonMethodCalls.filter(
        (call) => call.method === "daemon/heartbeat" && call.params.sessionId === sessionUuid,
      ).length;
    const before = heartbeatsFor(SESSION);
    await advance(INTERVAL_MS * 3);
    expect(heartbeatsFor(SESSION)).toBeGreaterThan(before);
  });

  // #10972 #1: the instant the last ack reported has passed, but that ack predates it; a call the
  // proxy did not see (inside the daemon's grace) may have moved it. Only a fresh ack can tell.
  test("a reported instant that passed after its ack is re-asked, not acted on", async () => {
    daemonWindowMs = PROXY_WINDOW_MS;
    await proxy.callTool("getAndroid", {});
    const reportedRelease = timer.now() + PROXY_WINDOW_MS;
    await advance(PROXY_WINDOW_MS - 500);
    // Use the proxy never credited (another client's input on this session) moves the instant.
    daemonMethodResults.set("daemon/heartbeat", {
      sessionId: SESSION,
      idleReleaseAt: timer.now() + PROXY_WINDOW_MS,
    });
    await advance(reportedRelease - timer.now() + INTERVAL_MS * 2);

    await proxy.callTool("observe", {});
    expect(client.callToolCalls.at(-1)).toMatchObject({
      toolName: "observe",
      params: { sessionUuid: SESSION },
    });
  });

  test("a daemon that reports nothing leaves the proxy's own window as the fallback", async () => {
    daemonReportsIdleRelease = false;
    await proxy.callTool("getAndroid", {});
    await advance(PROXY_WINDOW_MS + INTERVAL_MS * 3);
    await expect(proxy.callTool("observe", {})).rejects.toThrow(/Call getAndroid or getApple/);
  });

  test("a serial the proxy never recorded credits the session the daemon routed it to (#10974)", async () => {
    // The daemon kept the session when the same device came back on emulator-5560; its selector
    // matches the new identity, but the proxy only ever saw emulator-5554. The daemon echoes the
    // session it routed the call to, and the proxy credits that.
    daemonReportsIdleRelease = false;
    await proxy.callTool("getAndroid", {});
    for (let elapsed = 0; elapsed < PROXY_WINDOW_MS * 5; elapsed += 60_000) {
      await advance(60_000);
      await proxy.callTool("pressButton", { deviceId: "emulator-5560", button: "back" });
    }
    expect(client.callToolCalls.at(-1)).toMatchObject({
      toolName: "pressButton",
      params: { deviceId: "emulator-5560" },
    });
    const before = heartbeatCount();
    await advance(INTERVAL_MS * 3);
    expect(heartbeatCount()).toBeGreaterThan(before);
  });
});
