import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_RELEASE_SESSION_METHOD,
  DAEMON_VERSION,
} from "../../src/daemon/wire/constants";
import { ProcessLifecycleHandlers } from "../../src/processLifecycle";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeProcess } from "../fakes/FakeProcess";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

test("stdout close without stdin EOF releases the proxy's session and stops heartbeating", async () => {
  const timer = new FakeTimer();
  const fakeProcess = new FakeProcess();
  const stdin = new EventEmitter<{ end: []; close: []; error: [Error] }>();
  const stdout = new EventEmitter<{ close: []; error: [Error] }>();
  const client = new FakeDaemonClient({
    toolResultFor: (name) =>
      name === "getApple"
        ? {
            content: [
              {
                type: "text",
                text: JSON.stringify({ runtime: { session: { sessionUuid: "owned" } } }),
              },
            ],
          }
        : undefined,
  });
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  const proxy = new DaemonMcpProxy({
    clientFactory: () => client,
    daemonManager: manager,
    daemonAvailabilityProbe: async () => true,
    autoStartDaemon: false,
    idGenerator: new FakeIdGenerator(["owner-token"]),
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 4_000,
    timer,
  });
  const lifecycle = new ProcessLifecycleHandlers(fakeProcess, timer);
  let outputStopped = false;
  lifecycle.installStdinShutdownHandlers(stdin);
  lifecycle.installStdoutShutdownHandler(stdout, () => {
    outputStopped = true;
  });
  // This is the stdio shutdown stage's existing proxy-close operation.
  lifecycle.setShutdownHandler(() => proxy.close());
  const heartbeats = () =>
    client.callDaemonMethodCalls.filter(({ method }) => method === DAEMON_HEARTBEAT_METHOD);

  try {
    await proxy.callTool("getApple", {});
    const claimed = heartbeats().length;
    expect(claimed).toBeGreaterThan(0);
    expect(heartbeats()[0].params).toMatchObject({
      sessionId: "owned",
      livenessOwnerToken: "owner-token",
      claimLivenessOwnership: true,
    });
    timer.advanceTime(1_000);
    await drainMicrotasks(200);
    expect(heartbeats().length).toBeGreaterThan(claimed);
    const beforeClose = heartbeats().length;

    // Only the output side closes. No stdin end/close, write error, or process signal.
    stdout.emit("close");
    await drainMicrotasks(200);
    timer.advanceTime(1_000);
    await drainMicrotasks(200);

    expect(heartbeats()).toHaveLength(beforeClose);
    expect(outputStopped).toBe(true);
    expect(
      client.callDaemonMethodCalls.filter(({ method }) => method === DAEMON_RELEASE_SESSION_METHOD),
    ).toEqual([
      {
        method: DAEMON_RELEASE_SESSION_METHOD,
        params: { sessionId: "owned", livenessOwnerToken: "owner-token" },
      },
    ]);
    expect(client.isConnected()).toBe(false);
    expect(timer.getPendingIntervalCount()).toBe(0);
    expect(fakeProcess.exitCodes).toEqual([0]);
  } finally {
    await proxy.close();
  }
});
