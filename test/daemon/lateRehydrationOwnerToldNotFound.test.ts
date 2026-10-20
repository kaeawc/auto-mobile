import { describe, expect, test } from "bun:test";
import type { DaemonClientLike } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import {
  DaemonMcpProxy,
  RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS,
} from "../../src/daemon/daemonMcpProxy";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager, type SessionDeviceAssigner } from "../../src/daemon/sessionManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntil } from "../helpers/fakeTimerStepping";

// #11461 (restart ownership). A `daemon-shutdown` / `daemon-restart` release is a recoverable
// handoff: "the restarted daemon rehydrates the session; its owner reclaims it under the same
// UUID" (docs/using/device-ownership.md). The two halves do not meet when the row is still
// recovering after the 15 s startup deadline (a late row, or one left to the follow-up sweep):
//
// - the daemon's socket is up, the session is not in the session map yet, and the owner's
//   heartbeat is answered `Session not found` with `releaseReason: daemon-shutdown`;
// - the proxy classifies that as a recoverable handoff and keeps the binding; it used to stop
//   heartbeating it "until a call reaches it again";
// - the row's recovery then lands, the session is published awaiting-owner, and the monitor
//   released it as `rehydration-owner-timeout` (terminal) one lease plus grace later, because the
//   owner, alive and connected the whole time, had gone quiet. The proxy now keeps heartbeating a
//   recoverable not-found binding, so its next tick reclaims the session.
//
// Both sides are the real code here: the proxy's keeper talks to the real daemon request handler,
// session manager and heartbeat monitor over a fake transport, all on one fake clock.

const INTERVAL_MS = 1_000;
const LEASE_MS = 4_000;
const SESSION = "5e550000-0000-4000-8000-00000000000b";
const SIM = "SIM-LATE-ROW";

function matchingDaemonManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
}

/** What became of SESSION after the owner stayed connected, agent idle, for 12 s past the restart. */
async function ownerOutcomeAfterRestart(recovery: "lands-before-owner" | "lands-after-owner") {
  const timer = new FakeTimer();

  // --- The owner: a stdio proxy bound to SESSION on the daemon that is about to restart.
  const oldDaemon = new FakeDaemonClient();
  let restarted: SessionManager | undefined;
  let state: DaemonStateAccess | undefined;
  const heartbeatAnswers: string[] = [];
  const replacementDaemon = new FakeDaemonClient({
    onCallDaemonMethod: async (method, params) => {
      if (method !== "daemon/heartbeat" || !state) {
        return undefined;
      }
      const answer = await handleDaemonRequest(
        { id: "heartbeat", type: "daemon_request", method, params },
        state,
      );
      if (answer.success) {
        heartbeatAnswers.push("ack");
        return answer.result;
      }
      const failure = answer as { error?: string; code?: string; releaseReason?: string };
      heartbeatAnswers.push(`${failure.code}:${failure.releaseReason}`);
      throw Object.assign(new Error(failure.error), {
        code: failure.code,
        releaseReason: failure.releaseReason,
      });
    },
  });
  const clients: DaemonClientLike[] = [oldDaemon, replacementDaemon];
  const proxy = new DaemonMcpProxy({
    initialSessionUuid: SESSION,
    clientFactory: () => clients.shift() ?? replacementDaemon,
    daemonAvailabilityProbe: async () => true,
    daemonManager: matchingDaemonManager(),
    autoStartDaemon: false,
    timer,
    idGenerator: new FakeIdGenerator(),
    heartbeatTimeoutMs: LEASE_MS,
    heartbeatIntervalMs: INTERVAL_MS,
  });
  let monitor: SessionHeartbeatMonitor | undefined;
  try {
    await proxy.callTool("observe", { sessionUuid: SESSION });
    await timer.advanceTimeAsync(INTERVAL_MS);

    // --- The restarted daemon: SESSION's row is a recoverable handoff, and its recovery is slow
    // (its device's identity has not resolved yet), so it outlasts the startup deadline.
    const persistence = new FakeDeviceSessionPersistence();
    await persistence.upsertActiveSession({
      sessionUuid: SESSION,
      deviceId: SIM,
      stableDeviceId: SIM,
      platform: "ios",
      createdAtMs: 0,
      lastUsedAtMs: timer.now(),
      expiresAtMs: timer.now() + 600_000,
      sessionTimeoutMs: 600_000,
      heartbeatTimeoutMs: LEASE_MS,
      heartbeatTimeoutSource: "default",
      hasReceivedHeartbeat: true,
    });
    await persistence.markReleased(SESSION, "released", timer.now(), "daemon-shutdown");
    restarted = new SessionManager(timer, persistence);
    restarted.stopCleanupTimer();
    const manager = restarted;
    const deviceResolved = Promise.withResolvers<void>();
    const slowPool: SessionDeviceAssigner = {
      async assignDeviceToSession(sessionId, _platform, target): Promise<string> {
        await deviceResolved.promise;
        const session = await manager.createSession(sessionId, target?.deviceId ?? SIM, "ios", {
          timeoutMs: target?.liveness?.sessionTimeoutMs,
          heartbeatTimeoutMs: target?.liveness?.heartbeatTimeoutMs,
          stableDeviceId: target?.stableDeviceId,
          recoveredLiveness: target?.liveness,
          initialOwnership: target?.initialOwnership,
        });
        return session.assignedDevice;
      },
    };
    const startup = manager.rehydratePersistedSessions(slowPool, { deadlineMs: 1 });
    await timer.advanceTimeAsync(1);
    expect((await startup).skipped).toEqual([{ sessionUuid: SESSION, reason: "startup-deadline" }]);
    // Whether the deadline caught the row started or left it to the follow-up sweep, its recovery
    // is in flight from here on.
    await timer.advanceTimeAsync(0);

    // Startup continues: the monitor and the control socket come up with the row still recovering.
    const releases: string[] = [];
    manager.onSessionRelease((_sessionId, _deviceId, releaseReason) => {
      releases.push(releaseReason);
    });
    monitor = new SessionHeartbeatMonitor(
      manager,
      () => false,
      async (sessionId, reason) => {
        await manager.releaseSession(sessionId, reason, { allowExpired: true });
      },
      timer,
    );
    manager.startRehydratedOwnerWindows();
    monitor.start();
    state = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getDevicePool: () => {
        throw new Error("no device pool call is expected");
      },
      getDeviceSessionRegistry: () => ({ list: () => [] }),
    };
    const land = async () => {
      // The row's recovery lands: the session is published, waiting for its owner.
      deviceResolved.resolve();
      await drainUntil(() => manager.hasSession(SESSION), {
        description: "the late row's recovery to publish its session",
      });
    };

    if (recovery === "lands-before-owner") {
      await land();
    }
    // The owner's connection drops with the old daemon and its keeper reaches the new one.
    oldDaemon.emitConnectionClosed();
    await timer.advanceTimeAsync(2 * INTERVAL_MS);
    if (recovery === "lands-after-owner") {
      await land();
    }

    // The owner stays connected, agent idle, for well past the owner-reconnect window.
    for (let second = 0; second < 12; second++) {
      await timer.advanceTimeAsync(INTERVAL_MS);
    }

    return {
      firstHeartbeatAnswer: heartbeatAnswers[0],
      releases,
      live: manager.getSession(SESSION) !== null,
      terminal: manager.getTerminalReleaseSnapshot(SESSION)?.releaseReason,
    };
  } finally {
    monitor?.stop();
    restarted?.stopCleanupTimer();
    await proxy.close();
  }
}

/** A client whose close, like the real one, rejects every request still pending on it. */
class ClosableDaemonClient extends FakeDaemonClient {
  closes = 0;
  readonly pending = new Set<(error: Error) => void>();

  override async close(): Promise<void> {
    this.closes += 1;
    for (const reject of this.pending) {
      reject(new Error("Socket connection closed"));
    }
    this.pending.clear();
    await super.close();
  }
}

describe("a heartbeat answered not-found with a release reason", () => {
  /**
   * The owner's keeper against a daemon that answers every heartbeat not-found with
   * `releaseReason`, for `ticks` keeper ticks after the first such answer, with a tool call of a
   * sibling session in flight on the same connection throughout.
   */
  async function keeperAfterNotFound(releaseReason: string, ticks: number) {
    const timer = new FakeTimer();
    let gone = false;
    const claims: boolean[] = [];
    let connections = 0;
    const releaseInFlight = Promise.withResolvers<void>();
    const clients: ClosableDaemonClient[] = [];
    const newClient = (): ClosableDaemonClient => {
      const client: ClosableDaemonClient = new ClosableDaemonClient({
        onCallDaemonMethod: (method, params) => {
          if (method !== "daemon/heartbeat" || !gone || params.sessionId !== SESSION) {
            return;
          }
          claims.push(params.claimLivenessOwnership === true);
          throw Object.assign(new Error(`Session not found: ${SESSION}`), {
            code: "daemon_session_not_found",
            releaseReason,
          });
        },
        onCallTool: async (name) => {
          if (name !== "listDevices") {
            return;
          }
          const closed = Promise.withResolvers<void>();
          client.pending.add(closed.reject);
          await Promise.race([releaseInFlight.promise, closed.promise]);
        },
      });
      clients.push(client);
      return client;
    };
    const proxy = new DaemonMcpProxy({
      initialSessionUuid: SESSION,
      clientFactory: () => {
        connections += 1;
        return newClient();
      },
      daemonAvailabilityProbe: async () => true,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(),
      heartbeatTimeoutMs: LEASE_MS,
      heartbeatIntervalMs: INTERVAL_MS,
    });
    try {
      await proxy.callTool("observe", { sessionUuid: SESSION });
      await timer.advanceTimeAsync(INTERVAL_MS);
      gone = true;
      // The first not-found answer is retried once on a fresh connection, as on main.
      await timer.advanceTimeAsync(INTERVAL_MS);
      const baseline = {
        connections,
        closes: clients.reduce((sum, client) => sum + client.closes, 0),
      };
      const inFlight = proxy.callTool("listDevices", {}).then(
        () => "answered",
        (error: unknown) => `cut: ${error instanceof Error ? error.message : String(error)}`,
      );
      const perTick: number[] = [];
      const claimed: boolean[] = [];
      for (let tick = 0; tick < ticks; tick++) {
        const before = claims.length;
        await timer.advanceTimeAsync(INTERVAL_MS);
        perTick.push(claims.length - before);
        claimed.push(...claims.slice(before));
      }
      const resets = {
        connections: connections - baseline.connections,
        closes: clients.reduce((sum, client) => sum + client.closes, 0) - baseline.closes,
      };
      releaseInFlight.resolve();
      return { perTick, claimed, resets, inFlight: await inFlight };
    } finally {
      releaseInFlight.resolve();
      await proxy.close();
    }
  }

  test.each(["daemon-restart", "device-restart:Pixel"])(
    "%s: one heartbeat per tick, no connection reset, a call in flight survives",
    async (reason) => {
      const outcome = await keeperAfterNotFound(reason, 10);

      expect(outcome).toEqual({
        perTick: Array.from({ length: 10 }, () => 1),
        // Every heartbeat asks for ownership again, so the session is reclaimed when it lands.
        claimed: Array.from({ length: 10 }, () => true),
        resets: { connections: 0, closes: 0 },
        inFlight: "answered",
      });
    },
  );

  test("the keeper stops once the restart-recovery window has passed", async () => {
    const windowTicks = RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS / INTERVAL_MS;
    const { perTick, resets } = await keeperAfterNotFound("daemon-restart", windowTicks + 20);

    // The window is counted from the first not-found answer, one tick before these.
    expect(perTick.slice(0, windowTicks - 1)).toEqual(
      Array.from({ length: windowTicks - 1 }, () => 1),
    );
    // The tick at the bound still asks once (and learns the window is over); none follow.
    expect(perTick.slice(windowTicks)).toEqual(Array.from({ length: 20 }, () => 0));
    expect(resets).toEqual({ connections: 0, closes: 0 });
  });

  test("a terminal reason is never heartbeated again", async () => {
    const { perTick } = await keeperAfterNotFound("heartbeat-timeout", 3);

    expect(perTick).toEqual([0, 0, 0]);
  });
});

describe("a live owner whose session finishes rehydrating after the startup deadline", () => {
  test("control: a session already rehydrated when the owner reconnects is kept", async () => {
    expect(await ownerOutcomeAfterRestart("lands-before-owner")).toEqual({
      firstHeartbeatAnswer: "ack",
      releases: [],
      live: true,
      terminal: undefined,
    });
  });

  test("a session that lands after the owner's first heartbeat is kept too", async () => {
    const outcome = await ownerOutcomeAfterRestart("lands-after-owner");

    // The daemon told the reconnected owner its session was not found (a recoverable handoff)...
    expect(outcome.firstHeartbeatAnswer).toBe("daemon_session_not_found:daemon-shutdown");
    // ...and must not then end the session for the owner "never reclaiming" it.
    expect(outcome).toMatchObject({ releases: [], live: true, terminal: undefined });
  });
});
