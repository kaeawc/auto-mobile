import { describe, expect, test } from "bun:test";
import { DaemonMcpProxy } from "../../../src/daemon/daemonMcpProxy";
import type { DaemonClientLike } from "../../../src/daemon/client";
import { DAEMON_VERSION } from "../../../src/daemon/constants";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../../src/daemon/types";
import { FakeDaemonManager } from "../../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

// Hunt 2026-10-10 (proxy liveness). A replacement daemon answers a heartbeat with a plain
// "session not found" (no release reason) for a persisted session it has not materialized yet; the
// keeper tick deliberately does NOT fence the binding on that answer, because the next tool call
// restores the session (daemonMcpProxy.test.ts "keeps a persisted binding recoverable when the
// keeper reaches its replacement daemon first", and the comment in sendBoundSessionHeartbeat).
//
// That only holds when a tick reaches the replacement daemon directly. A real restart has a gap in
// which nothing listens. Once the gap outlasts one heartbeat request (2 s at the default 4 s lease
// / 1 s cadence) the tick waiting in it starts LivenessRecovery (daemon_stalled), and the recovery
// attempt that then reaches the replacement daemon treats the very same plain
// not-found as proof of loss and terminally fences the binding (settle -> onSessionGone ->
// dropGoneSession -> fenceBoundSessionUuid("session-not-found")). The tool call that would have
// restored the session is refused locally and never reaches the daemon.

const INTERVAL_MS = 1_000;
const LEASE_MS = 4_000;
const SESSION = "persisted-session";

function matchingDaemonManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
}

function plainSessionNotFound(): Error {
  return Object.assign(new Error(`Session not found: ${SESSION}`), {
    code: DAEMON_SESSION_NOT_FOUND_CODE,
  });
}

interface Restart {
  timer: FakeTimer;
  oldDaemon: FakeDaemonClient;
  replacementDaemon: FakeDaemonClient;
  proxy: DaemonMcpProxy;
  setReachable(reachable: boolean): void;
  replacementHeartbeats(): number;
}

/** A proxy bound to a persisted session whose daemon is about to be replaced. */
async function boundProxyBeforeRestart(): Promise<Restart> {
  const timer = new FakeTimer();
  let reachable = true;
  let materialized = false;
  let acknowledged = 0;
  const oldDaemon = new FakeDaemonClient();
  const replacementDaemon = new FakeDaemonClient({
    onCallDaemonMethod: (method) => {
      if (method !== "daemon/heartbeat") {
        return;
      }
      if (!materialized) {
        // Persisted, not yet materialized: a device operation restores it.
        throw plainSessionNotFound();
      }
      acknowledged += 1;
    },
    onCallTool: () => {
      materialized = true;
    },
  });
  const clients: DaemonClientLike[] = [oldDaemon, replacementDaemon];
  const proxy = new DaemonMcpProxy({
    initialSessionUuid: SESSION,
    clientFactory: () => clients.shift() ?? replacementDaemon,
    daemonAvailabilityProbe: async () => reachable,
    daemonManager: matchingDaemonManager(),
    autoStartDaemon: false,
    timer,
    idGenerator: new FakeIdGenerator(),
    heartbeatTimeoutMs: LEASE_MS,
    heartbeatIntervalMs: INTERVAL_MS,
  });
  await proxy.callTool("observe", { sessionUuid: SESSION });
  await timer.advanceTimeAsync(INTERVAL_MS);
  return {
    timer,
    oldDaemon,
    replacementDaemon,
    proxy,
    setReachable: (value) => {
      reachable = value;
    },
    replacementHeartbeats: () => acknowledged,
  };
}

describe("hunt: liveness recovery vs a replacement daemon that has not materialized the session", () => {
  test("control: a tick that reaches the replacement daemon directly keeps the binding", async () => {
    const restart = await boundProxyBeforeRestart();
    try {
      // The old socket drops and the replacement is already listening: no unreachable gap.
      restart.oldDaemon.emitConnectionClosed();
      await restart.timer.advanceTimeAsync(2 * INTERVAL_MS);

      await expect(restart.proxy.callTool("observe", {})).resolves.toBeDefined();
      expect(restart.replacementDaemon.callToolCalls).toEqual([
        { toolName: "observe", params: { sessionUuid: SESSION } },
      ]);
    } finally {
      await restart.proxy.close();
    }
  });

  test("a restart gap longer than one heartbeat request must not fence the binding the next call would restore", async () => {
    const restart = await boundProxyBeforeRestart();
    try {
      // The daemon goes away for 4 s: the keeper tick waiting on it gets no acknowledgement
      // within its request timeout and starts recovery.
      restart.setReachable(false);
      restart.oldDaemon.emitConnectionClosed();
      await restart.timer.advanceTimeAsync(LEASE_MS);

      // The replacement daemon is up. The next recovery attempt reaches it and is answered plain
      // not-found; the call below arrives inside its awaiting-owner window (lease + 4 s grace).
      restart.setReachable(true);
      await restart.timer.advanceTimeAsync(2 * INTERVAL_MS);

      // The first device operation restores the persisted session, exactly as in the control.
      const outcome = await restart.proxy.callTool("observe", {}).then(
        () => "forwarded",
        (error: unknown) =>
          `refused locally: ${error instanceof Error ? error.message : String(error)}`,
      );
      expect(outcome).toBe("forwarded");
      expect(restart.replacementDaemon.callToolCalls).toEqual([
        { toolName: "observe", params: { sessionUuid: SESSION } },
      ]);

      // Once restored, the keeper heartbeats it again.
      await restart.timer.advanceTimeAsync(2 * INTERVAL_MS);
      expect(restart.replacementHeartbeats()).toBeGreaterThan(0);
    } finally {
      await restart.proxy.close();
    }
  });
});
