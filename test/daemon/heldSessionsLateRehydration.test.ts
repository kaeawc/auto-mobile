import { describe, expect } from "bun:test";
import type { DaemonClientLike } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
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
import { warmedTests } from "../helpers/warmedTests";

// #11557 item 2, both sides. An agent drives two devices through one stdio proxy: two acquired
// sessions, the second being the proxy's latest binding. The daemon is replaced, and the new one
// is still recovering both rows (they outlast the startup deadline) when the proxy reconnects, so
// each session's first heartbeat on the new connection is answered `Session not found`.
//
// The answer normally names the handoff the startup recorded on the row (`daemon-restart`), and
// the proxy then keeps heartbeating both sessions (#11461). It names nothing when the daemon
// cannot say why: the reason is looked up best-effort, so a failed read of the row (a database
// busy with startup) answers a plain not-found. The proxy used to wait through that only for its
// latest binding (#11529) and drop the other session after that one answer. The row's recovery
// then landed, the session was published waiting for its owner, and the monitor released it as
// `rehydration-owner-timeout` (terminal) one lease plus grace later, although its owner was alive
// and connected the whole time.
//
// Both sides are the real code here: the proxy's keeper talks to the real daemon request handler,
// session manager and heartbeat monitor over a fake transport, all on one fake clock.

const INTERVAL_MS = 1_000;
const LEASE_MS = 4_000;
const HELD = "5e550000-0000-4000-8000-0000000000a1";
const LATEST = "5e550000-0000-4000-8000-0000000000a2";
const DEVICES: Record<string, string> = { [HELD]: "SIM-HELD", [LATEST]: "SIM-LATEST" };

function matchingDaemonManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
}

/**
 * What became of both sessions after their owner stayed connected, agent idle, past the restart.
 * `reasonLookup`: whether the replacement daemon can read why a session is not found when the
 * owner's first heartbeats arrive.
 */
async function ownerOutcomeAfterRestart(reasonLookup: "works" | "fails at first") {
  const timer = new FakeTimer();

  // --- The owner: a stdio proxy that acquired HELD, then LATEST, on the daemon about to die.
  const toMint = [HELD, LATEST];
  const oldDaemon = new FakeDaemonClient({
    toolResultFor: (name) =>
      name === "getApple"
        ? {
            content: [
              {
                type: "text",
                text: JSON.stringify({ runtime: { session: { sessionUuid: toMint.shift() } } }),
              },
            ],
          }
        : undefined,
  });
  let state: DaemonStateAccess | undefined;
  const heartbeatAnswers: Record<string, string[]> = { [HELD]: [], [LATEST]: [] };
  const replacementDaemon = new FakeDaemonClient({
    onCallDaemonMethod: async (method, params) => {
      if (method !== "daemon/heartbeat" || !state || typeof params.sessionId !== "string") {
        return undefined;
      }
      const answers = heartbeatAnswers[params.sessionId]!;
      const answer = await handleDaemonRequest(
        { id: "heartbeat", type: "daemon_request", method, params },
        state,
      );
      if (answer.success) {
        answers.push("ack");
        return answer.result;
      }
      const failure = answer as { error?: string; code?: string; releaseReason?: string };
      answers.push(`${failure.code}:${failure.releaseReason}`);
      throw Object.assign(new Error(failure.error), {
        code: failure.code,
        releaseReason: failure.releaseReason,
      });
    },
  });
  const clients: DaemonClientLike[] = [oldDaemon, replacementDaemon];
  const proxy = new DaemonMcpProxy({
    clientFactory: () => clients.shift() ?? replacementDaemon,
    daemonAvailabilityProbe: async () => true,
    daemonManager: matchingDaemonManager(),
    autoStartDaemon: false,
    timer,
    idGenerator: new FakeIdGenerator(),
    heartbeatTimeoutMs: LEASE_MS,
    heartbeatIntervalMs: INTERVAL_MS,
  });
  let restarted: SessionManager | undefined;
  let monitor: SessionHeartbeatMonitor | undefined;
  try {
    await proxy.callTool("getApple", {});
    await proxy.callTool("getApple", {});
    await timer.advanceTimeAsync(INTERVAL_MS);

    // --- The replacement daemon: startup marked both rows of the daemon it replaced as a
    // recoverable handoff, and their recovery is slow, so it outlasts the startup deadline.
    const persistence = new FakeDeviceSessionPersistence();
    for (const sessionUuid of [HELD, LATEST]) {
      await persistence.upsertActiveSession({
        sessionUuid,
        deviceId: DEVICES[sessionUuid]!,
        stableDeviceId: DEVICES[sessionUuid]!,
        platform: "ios",
        createdAtMs: 0,
        lastUsedAtMs: timer.now(),
        expiresAtMs: timer.now() + 600_000,
        sessionTimeoutMs: 600_000,
        heartbeatTimeoutMs: LEASE_MS,
        heartbeatTimeoutSource: "default",
        hasReceivedHeartbeat: true,
      });
      await persistence.markReleased(sessionUuid, "released", timer.now(), "daemon-restart");
    }
    restarted = new SessionManager(timer, persistence);
    restarted.stopCleanupTimer();
    const manager = restarted;
    const devicesResolved = Promise.withResolvers<void>();
    const slowPool: SessionDeviceAssigner = {
      async assignDeviceToSession(sessionId, _platform, target): Promise<string> {
        await devicesResolved.promise;
        const session = await manager.createSession(
          sessionId,
          target?.deviceId ?? DEVICES[sessionId]!,
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
    expect((await startup).skipped.map((row) => row.sessionUuid).sort()).toEqual([HELD, LATEST]);
    await timer.advanceTimeAsync(0);

    // Startup continues: the monitor and the control socket come up with both rows recovering.
    const releases: string[] = [];
    manager.onSessionRelease((sessionId, _deviceId, releaseReason) => {
      releases.push(`${sessionId === HELD ? "held" : "latest"}:${releaseReason}`);
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

    // Both rows are parked in recovery; from here on the daemon reads a row only to say why a
    // session is not found.
    const readRow = persistence.getSession.bind(persistence);
    let rowsReadable = reasonLookup === "works";
    persistence.getSession = async (sessionUuid) => {
      if (!rowsReadable) {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return readRow(sessionUuid);
    };

    // The owner's connection drops with the old daemon and its keeper reaches the new one, which
    // knows neither session yet.
    oldDaemon.emitConnectionClosed();
    await timer.advanceTimeAsync(2 * INTERVAL_MS);
    rowsReadable = true;
    // Both rows' recovery lands: the sessions are published, waiting for their owner.
    devicesResolved.resolve();
    await drainUntil(() => manager.hasSession(HELD) && manager.hasSession(LATEST), {
      description: "both late rows' recovery to publish their sessions",
    });

    // The owner stays connected, agent idle, for well past the owner-reconnect window.
    for (let second = 0; second < 12; second++) {
      await timer.advanceTimeAsync(INTERVAL_MS);
    }

    return {
      firstHeartbeatAnswers: {
        held: heartbeatAnswers[HELD]![0],
        latest: heartbeatAnswers[LATEST]![0],
      },
      releases,
      live: {
        held: manager.getSession(HELD) !== null,
        latest: manager.getSession(LATEST) !== null,
      },
      terminal: {
        held: manager.getTerminalReleaseSnapshot(HELD)?.releaseReason,
        latest: manager.getTerminalReleaseSnapshot(LATEST)?.releaseReason,
      },
    };
  } finally {
    monitor?.stop();
    restarted?.stopCleanupTimer();
    await proxy.close();
  }
}

describe("a live owner of two sessions that finish rehydrating after it reconnected", () => {
  // Each scenario owns and cleans up its fakes; warm the proxy/rehydration path outside test timing.
  const test = warmedTests(() => {});

  test("control: told not-found with the restart handoff, it keeps both", async () => {
    const outcome = await ownerOutcomeAfterRestart("works");

    expect(outcome.firstHeartbeatAnswers).toEqual({
      held: "daemon_session_not_found:daemon-restart",
      latest: "daemon_session_not_found:daemon-restart",
    });
    expect(outcome).toMatchObject({
      releases: [],
      live: { held: true, latest: true },
      terminal: { held: undefined, latest: undefined },
    });
  });

  test("told not-found with no reason, it keeps the session that is not its latest binding too", async () => {
    const outcome = await ownerOutcomeAfterRestart("fails at first");

    // The daemon told the reconnected owner it knew neither session, and could not say why...
    expect(outcome.firstHeartbeatAnswers).toEqual({
      held: "daemon_session_not_found:undefined",
      latest: "daemon_session_not_found:undefined",
    });
    // ...and must not then end either for its owner "never reclaiming" it.
    expect(outcome).toMatchObject({
      releases: [],
      live: { held: true, latest: true },
      terminal: { held: undefined, latest: undefined },
    });
  });
});
