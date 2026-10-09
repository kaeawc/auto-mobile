import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_BOUND_SESSION_REPLAY_TTL_MS, DAEMON_VERSION } from "../../src/daemon/constants";
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
const DAEMON_WINDOW_MS = PROXY_WINDOW_MS * 5;
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
        idleReleaseAt: timer.now() + DAEMON_WINDOW_MS,
      });
    }
  }

  beforeEach(() => {
    timer = new FakeTimer();
    daemonMethodResults = new Map();
    daemonReportsIdleRelease = true;
    client = new FakeDaemonClient({
      daemonMethodResults,
      toolResultFor: (name) => {
        daemonSawToolCall();
        return name === "getAndroid" ? deviceStartResult() : undefined;
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
    await advance(DAEMON_WINDOW_MS + INTERVAL_MS * 3);
    await expect(proxy.callTool("observe", {})).rejects.toThrow(/Call getAndroid or getApple/);
    const afterWindow = heartbeatCount();
    await advance(INTERVAL_MS * 10);
    expect(heartbeatCount()).toBe(afterWindow);
  });

  test("a daemon that reports nothing leaves the proxy's own window as the fallback", async () => {
    daemonReportsIdleRelease = false;
    await proxy.callTool("getAndroid", {});
    await advance(PROXY_WINDOW_MS + INTERVAL_MS * 3);
    await expect(proxy.callTool("observe", {})).rejects.toThrow(/Call getAndroid or getApple/);
  });

  test("a serial the proxy never recorded still credits the only live session", async () => {
    // The daemon kept the session when the same device came back on emulator-5560; its selector
    // matches the new identity, but the proxy only ever saw emulator-5554.
    daemonReportsIdleRelease = false;
    await proxy.callTool("getAndroid", {});
    for (let elapsed = 0; elapsed < PROXY_WINDOW_MS * 5; elapsed += 60_000) {
      await advance(60_000);
      await proxy.callTool("observe", { deviceId: "emulator-5560" });
    }
    expect(client.callToolCalls.at(-1)).toMatchObject({
      toolName: "observe",
      params: { deviceId: "emulator-5560" },
    });
    const before = heartbeatCount();
    await advance(INTERVAL_MS * 3);
    expect(heartbeatCount()).toBeGreaterThan(before);
  });
});
