import { describe, expect, test } from "bun:test";
import type { DaemonClientLike } from "../../../src/daemon/client";
import { DAEMON_VERSION } from "../../../src/daemon/constants";
import { DaemonMcpProxy } from "../../../src/daemon/daemonMcpProxy";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../../src/daemon/daemonRequestHandlers";
import { SessionHeartbeatMonitor } from "../../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager, type SessionDeviceAssigner } from "../../../src/daemon/sessionManager";
import { FakeDaemonClient } from "../../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../../fakes/FakeDaemonManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntil } from "../../helpers/fakeTimerStepping";

// Hunt (restart ownership). A `daemon-shutdown` / `daemon-restart` release is a recoverable
// handoff: "the restarted daemon rehydrates the session; its owner reclaims it under the same
// UUID" (docs/using/device-ownership.md). The two halves do not meet when the row is still
// recovering after the 15 s startup deadline (a late row, or one left to the follow-up sweep):
//
// - the daemon's socket is up, the session is not in the session map yet, and the owner's
//   heartbeat is answered `Session not found` with `releaseReason: daemon-shutdown`;
// - the proxy classifies that as a recoverable handoff, keeps the binding and stops heartbeating
//   it "until a call reaches it again";
// - the row's recovery then lands, the session is published awaiting-owner, and the monitor
//   releases it as `rehydration-owner-timeout` (terminal) one lease plus grace later, because the
//   owner, alive and connected the whole time, was told to stop heartbeating.
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
        const session = await manager.createSession(
          sessionId,
          target?.deviceId ?? SIM,
          "ios",
          target?.liveness?.sessionTimeoutMs,
          target?.liveness?.heartbeatTimeoutMs,
          target?.stableDeviceId,
          target?.liveness,
          target?.initialOwnership,
        );
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
        await manager.releaseSession(sessionId, reason, true);
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
