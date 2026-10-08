import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_BOUND_SESSION_REPLAY_TTL_MS, DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

// mt-0083 r1 finding 1: the bound session's replay lease (the 2 min idle window) must never
// expire while a call on it is still running, and restarts when the last such call ends. A call
// longer than the window plus any other request during it used to fence the binding and stop the
// heartbeats, so the daemon released a device that was in use.

const SESSION = "android-session";
const INTERVAL_MS = 2_000;
const LONG_CALL_MS = 5 * 60_000;
const IDLE_WINDOW_MS = DAEMON_BOUND_SESSION_REPLAY_TTL_MS;

function deviceStartResult(sessionUuid: string) {
  return {
    content: [{ type: "text", text: JSON.stringify({ runtime: { session: { sessionUuid } } }) }],
  };
}

describe("proxy keeps a bound session alive while a call on it is in flight", () => {
  let timer: FakeTimer;
  let client: FakeDaemonClient;
  let proxy: DaemonMcpProxy;
  let finishLongCall: (() => void) | undefined;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;

  function heartbeatCount(): number {
    return client.callDaemonMethodCalls.filter(
      (call) => call.method === "daemon/heartbeat" && call.params.sessionId === SESSION,
    ).length;
  }

  /** Whether the keeper heartbeats the bound session within the next few ticks. */
  async function nextTickHeartbeats(): Promise<boolean> {
    const before = heartbeatCount();
    await timer.advanceTimeAsync(INTERVAL_MS * 3);
    return heartbeatCount() > before;
  }

  beforeEach(() => {
    timer = new FakeTimer();
    finishLongCall = undefined;
    client = new FakeDaemonClient({
      toolResultFor: (name) => (name === "getAndroid" ? deviceStartResult(SESSION) : undefined),
      onCallTool: (name) =>
        name === "explore"
          ? new Promise<void>((resolve) => {
              finishLongCall = resolve;
            })
          : undefined,
    });
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
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
    finishLongCall?.();
    await proxy.close();
    isAvailableSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("a 5 min call with a concurrent tools/list and parallel call keeps the binding and its heartbeats", async () => {
    await proxy.callTool("getAndroid", {});
    const longCall = proxy.callTool("explore", {});
    await timer.advanceTimeAsync(0);
    expect(finishLongCall).toBeDefined();

    // Past the idle window measured from the acquisition, the client re-lists and calls again.
    await timer.advanceTimeAsync(IDLE_WINDOW_MS + 5_000);
    await proxy.listTools();
    expect(await nextTickHeartbeats()).toBeTrue();

    // Past the window again, measured from the parallel call's end, with explore still running.
    await proxy.callTool("observe", {});
    await timer.advanceTimeAsync(LONG_CALL_MS - IDLE_WINDOW_MS - 5_000);
    await proxy.listTools();
    expect(await nextTickHeartbeats()).toBeTrue();

    finishLongCall!();
    await longCall;
    expect(await nextTickHeartbeats()).toBeTrue();

    await proxy.callTool("observe", {});
    expect(client.callToolCalls.at(-1)).toMatchObject({
      toolName: "observe",
      params: { sessionUuid: SESSION },
    });
  });

  test("the binding expires the idle window after the last call ends, not after it starts", async () => {
    await proxy.callTool("getAndroid", {});
    const longCall = proxy.callTool("explore", {});
    await timer.advanceTimeAsync(LONG_CALL_MS);
    finishLongCall!();
    await longCall;

    await timer.advanceTimeAsync(IDLE_WINDOW_MS - INTERVAL_MS * 4);
    await proxy.listTools();
    expect(await nextTickHeartbeats()).toBeTrue();

    await timer.advanceTimeAsync(INTERVAL_MS);
    await proxy.listTools();
    expect(await nextTickHeartbeats()).toBeFalse();
  });
});
