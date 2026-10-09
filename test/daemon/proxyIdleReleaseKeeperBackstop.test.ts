import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_BOUND_SESSION_REPLAY_TTL_MS, DAEMON_VERSION } from "../../src/daemon/constants";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../src/daemon/types";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

// #10702: an idle release is routine (2 min after the last tool call). When the daemon's
// session-released notification is missed, the keeper must still stop instead of heartbeating a
// released session forever, and an agent that names the released session gets told how to
// recover on the same transport.

const INTERVAL_MS = 2_000;
const IDLE_WINDOW_MS = DAEMON_BOUND_SESSION_REPLAY_TTL_MS;

function deviceStartResult(sessionUuid: string) {
  return {
    content: [{ type: "text", text: JSON.stringify({ runtime: { session: { sessionUuid } } }) }],
  };
}

describe("#10702: the keeper stops after an idle release even when the notification is missed", () => {
  let timer: FakeTimer;
  let client: FakeDaemonClient;
  let proxy: DaemonMcpProxy;
  let minted: string;
  let released: Set<string>;
  /** How the daemon answers a heartbeat for a released session. */
  let releasedHeartbeatError: () => Error;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let infoSpy: ReturnType<typeof spyOn>;

  function heartbeatsFor(sessionUuid: string): number {
    return client.callDaemonMethodCalls.filter(
      (call) => call.method === "daemon/heartbeat" && call.params.sessionId === sessionUuid,
    ).length;
  }

  beforeEach(() => {
    timer = new FakeTimer();
    minted = "session-a";
    released = new Set();
    releasedHeartbeatError = () =>
      Object.assign(new Error(`Session not found: ${minted}`), {
        code: DAEMON_SESSION_NOT_FOUND_CODE,
      });
    client = new FakeDaemonClient({
      toolResultFor: (name) => (name === "getAndroid" ? deviceStartResult(minted) : undefined),
      onCallDaemonMethod: (method, params) => {
        if (method === "daemon/heartbeat" && released.has(params.sessionId)) {
          throw releasedHeartbeatError();
        }
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

  test("kept while in use: the keeper heartbeats through the idle window", async () => {
    await proxy.callTool("getAndroid", {});
    await timer.advanceTimeAsync(IDLE_WINDOW_MS - INTERVAL_MS * 2);
    const before = heartbeatsFor("session-a");
    await timer.advanceTimeAsync(INTERVAL_MS);
    expect(heartbeatsFor("session-a")).toBeGreaterThan(before);
  });

  test("a heartbeat answered not-found stops the keeper within a tick", async () => {
    await proxy.callTool("getAndroid", {});
    await timer.advanceTimeAsync(INTERVAL_MS * 5);
    // The daemon released the session; its notification never reached this proxy.
    released.add("session-a");
    await timer.advanceTimeAsync(INTERVAL_MS * 2);
    const afterLoss = heartbeatsFor("session-a");
    await timer.advanceTimeAsync(INTERVAL_MS * 30);
    expect(heartbeatsFor("session-a")).toBe(afterLoss);
  });

  test("a session a replacement daemon restores on the next call is heartbeated again", async () => {
    await proxy.callTool("getAndroid", {});
    released.add("session-a");
    await timer.advanceTimeAsync(INTERVAL_MS * 3);
    const stopped = heartbeatsFor("session-a");
    await timer.advanceTimeAsync(INTERVAL_MS * 3);
    expect(heartbeatsFor("session-a")).toBe(stopped);

    // The daemon knows the session again (for example restored by a tool call after a restart).
    released.delete("session-a");
    await proxy.callTool("observe", {});
    await timer.advanceTimeAsync(INTERVAL_MS * 3);
    expect(heartbeatsFor("session-a")).toBeGreaterThan(stopped);
  });

  test("past the idle window the keeper fences the binding and stops, whatever heartbeats answer", async () => {
    await proxy.callTool("getAndroid", {});
    // Heartbeats keep succeeding: nothing but the proxy's own idle window can stop the keeper.
    await timer.advanceTimeAsync(IDLE_WINDOW_MS + INTERVAL_MS);
    const afterWindow = heartbeatsFor("session-a");
    await timer.advanceTimeAsync(INTERVAL_MS * 30);
    expect(heartbeatsFor("session-a")).toBe(afterWindow);
    // The fenced binding tells a sessionless caller how to recover.
    await expect(proxy.callTool("observe", {})).rejects.toThrow(/Call getAndroid or getApple/);
  });

  test("past the idle window the keeper stops even while heartbeats fail for another reason", async () => {
    await proxy.callTool("getAndroid", {});
    released.add("session-a");
    // A heartbeat that fails without proving the session gone (for example a reconnecting socket).
    releasedHeartbeatError = () => new Error("socket reset");
    await timer.advanceTimeAsync(IDLE_WINDOW_MS + INTERVAL_MS * 2);
    const afterWindow = heartbeatsFor("session-a");
    await timer.advanceTimeAsync(INTERVAL_MS * 30);
    expect(heartbeatsFor("session-a")).toBe(afterWindow);
  });

  // #10972: with the notification missed, the heartbeat's not-found answer carries the daemon's
  // own release reason, and the agent sees that instead of the proxy's replay-lease-expired.
  test("a missed idle-release notification surfaces the daemon's reason from the heartbeat answer", async () => {
    await proxy.callTool("getAndroid", {});
    await timer.advanceTimeAsync(INTERVAL_MS * 5);
    releasedHeartbeatError = () =>
      Object.assign(new Error(`Session not found: ${minted}`), {
        code: DAEMON_SESSION_NOT_FOUND_CODE,
        releaseReason: "cleanup-expired",
        idle: true,
      });
    released.add("session-a");
    await timer.advanceTimeAsync(INTERVAL_MS * 2);

    const failure = await proxy.callTool("observe", { sessionUuid: "session-a" }).then(
      () => undefined,
      (error: unknown) => error as Error & { reason?: string },
    );
    expect(failure?.reason).toBe("cleanup-expired");
    expect(failure?.message).toContain("Call getAndroid or getApple");
    // Nothing was forwarded for the released session, and the keeper stopped.
    expect(client.callToolCalls.map((call) => call.toolName)).toEqual(["getAndroid"]);
    const afterLoss = heartbeatsFor("session-a");
    await timer.advanceTimeAsync(INTERVAL_MS * 10);
    expect(heartbeatsFor("session-a")).toBe(afterLoss);
  });

  for (const delivery of ["notified", "missed"] as const) {
    test(`an explicit sessionUuid call after an idle release (${delivery}) is told to call getAndroid, which recovers the transport`, async () => {
      await proxy.callTool("getAndroid", {});
      released.add("session-a");
      if (delivery === "notified") {
        client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, "session-a", "idle-timeout");
      }
      await timer.advanceTimeAsync(IDLE_WINDOW_MS + INTERVAL_MS * 2);

      const failure = await proxy.callTool("observe", { sessionUuid: "session-a" }).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failure?.message).toContain("session-a");
      expect(failure?.message).toContain("Call getAndroid or getApple");
      expect(failure?.message).not.toContain("start a new transport");

      minted = "session-b";
      await proxy.callTool("getAndroid", {});
      await proxy.callTool("observe", {});
      expect(client.callToolCalls.at(-1)).toMatchObject({
        toolName: "observe",
        params: { sessionUuid: "session-b" },
      });
    });
  }
});
