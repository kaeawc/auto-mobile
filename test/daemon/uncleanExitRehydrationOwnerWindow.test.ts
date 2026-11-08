import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager, type SessionDeviceAssigner } from "../../src/daemon/sessionManager";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  SUSPECT_GRACE_MS,
} from "../../src/daemon/wire/sessionLivenessWindows";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { logger } from "../../src/utils/logger";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { deliverDaemonHeartbeat } from "../helpers/daemonHeartbeatHandler";

// #17255: a daemon killed with SIGKILL leaves its sessions `active` in the database. The next
// daemon's startup sweep expires the rows of every daemon that is no longer live as
// `daemon-restart` and rehydrates them awaiting their owner. A session whose own lease is long
// (a CLI session's 2 min idle window) then held its device for that whole window, although the
// daemon that issued it is provably gone. A session of a previous daemon that died uncleanly now
// gets the default owner-reconnect window (lease plus suspect grace): a live owner (a proxy
// heartbeating every 2 s) still reclaims it, an absent one frees the device within seconds. A
// graceful restart (`daemon-shutdown`) keeps the session's own window, and a live but slow peer
// daemon's rows are never expired at all.

const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
const SHORT_WINDOW_MS = DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS + SUSPECT_GRACE_MS;
const CLI_IDLE_MS = DEFAULT_SESSION_IDLE_TIMEOUT_MS;
const DEAD_DAEMON = "daemon-killed-by-sigkill";
const NEW_DAEMON = "daemon-restarted";
const SLOW_PEER = "daemon-live-but-slow";
const SESSION = "cli-session-of-dead-daemon";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

/** A CLI session's active row, as the previous daemon left it. */
async function persistActiveCliRow(
  repository: DeviceSessionRepository,
  sessionUuid: string,
  daemonSessionId: string,
  nowMs: number,
): Promise<void> {
  await repository.upsertActiveSession({
    sessionUuid,
    deviceId: "emulator-5554",
    stableDeviceId: "Pixel_8_API_35",
    platform: "android",
    daemonSessionId,
    createdAtMs: nowMs - 1_000,
    lastUsedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs - 1_000 + CLI_IDLE_MS,
    sessionTimeoutMs: CLI_IDLE_MS,
    heartbeatTimeoutMs: CLI_IDLE_MS,
    heartbeatTimeoutSource: "default",
    hasReceivedHeartbeat: true,
    livenessPolicy: "cli-idle",
    preCliHeartbeatTimeoutMs: DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
    preCliHeartbeatTimeoutSource: "default",
    preCliSessionTimeoutMs: CLI_IDLE_MS,
  });
}

/**
 * Restart a daemon over `repository`: the startup sweep (unless `graceful` already released the
 * row), rehydration, and the heartbeat monitor that judges the owner-reconnect window.
 */
async function restartDaemon(options: { graceful: boolean }) {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  cleanups.push(() => warn.mockRestore());
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000_000);
  const repository = new DeviceSessionRepository({ db: await createTestDatabase(), timer });
  await persistActiveCliRow(repository, SESSION, DEAD_DAEMON, timer.now());
  if (options.graceful) {
    await repository.markReleased(SESSION, "expired", timer.now(), { reason: "daemon-shutdown" });
  }
  await repository.markStaleActiveSessionsExpired(
    NEW_DAEMON,
    timer.now(),
    "daemon-restart",
    new Set([NEW_DAEMON]),
  );

  const manager = new SessionManager(timer, repository);
  cleanups.push(() => manager.stopCleanupTimer());
  const devicePool: SessionDeviceAssigner = {
    async assignDeviceToSession(id, _platform, target): Promise<string> {
      const session = await manager.createSession(id, "emulator-5554", "android", {
        timeoutMs: target?.liveness?.sessionTimeoutMs,
        heartbeatTimeoutMs: target?.liveness?.heartbeatTimeoutMs,
        stableDeviceId: target?.stableDeviceId,
        recoveredLiveness: target?.liveness,
        initialOwnership: target?.initialOwnership,
      });
      return session.assignedDevice;
    },
  };
  const summary = await manager.rehydratePersistedSessions(devicePool);
  expect(summary.rehydrated).toEqual([SESSION]);

  const released: string[] = [];
  const monitor = new SessionHeartbeatMonitor(
    manager,
    () => false,
    async (sessionId, reason) => {
      released.push(reason);
      await manager.releaseSession(sessionId, reason);
    },
    { timer },
  );
  manager.startRehydratedOwnerWindows();
  monitor.start();
  cleanups.push(() => void monitor.stop());
  const advance = (ms: number) => timer.advanceTimeAsync(ms, () => drainMicrotasks(10));
  return { manager, released, advance };
}

describe("a session left by a daemon that exited uncleanly (#17255)", () => {
  test("is released once the default owner window passes, not after its own long window", async () => {
    const { manager, released, advance } = await restartDaemon({ graceful: false });
    expect(manager.getSession(SESSION)?.ownership).toBe("awaiting-owner");

    await advance(SHORT_WINDOW_MS);
    expect(released).toEqual([]);
    await advance(SCAN_MS);

    expect(released).toEqual(["rehydration-owner-timeout"]);
    expect(manager.getSession(SESSION)).toBeNull();
  });

  test("is kept by an owner that reconnects inside the window", async () => {
    const { manager, released, advance } = await restartDaemon({ graceful: false });

    await advance(SHORT_WINDOW_MS - SCAN_MS);
    await deliverDaemonHeartbeat(manager, SESSION);
    await advance(2 * SCAN_MS);

    expect(released).toEqual([]);
    expect(manager.getSession(SESSION)?.ownership).toBe("owned");
  });
});

describe("a session handed off by a graceful restart", () => {
  test("keeps its own owner window", async () => {
    const { manager, released, advance } = await restartDaemon({ graceful: true });

    await advance(SHORT_WINDOW_MS + 2 * SCAN_MS);

    expect(released).toEqual([]);
    expect(manager.getSession(SESSION)?.ownership).toBe("awaiting-owner");
  });
});

describe("a live but slow peer daemon's session", () => {
  test("is not expired by the restarted daemon's startup sweep", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    const repository = new DeviceSessionRepository({ db: await createTestDatabase(), timer });
    await persistActiveCliRow(repository, "peer-session", SLOW_PEER, timer.now());

    await repository.markStaleActiveSessionsExpired(
      NEW_DAEMON,
      timer.now(),
      "daemon-restart",
      new Set([NEW_DAEMON, SLOW_PEER]),
    );

    expect(await repository.getSession("peer-session")).toMatchObject({
      status: "active",
      release_reason: null,
      daemon_session_id: SLOW_PEER,
    });
  });
});
