import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  SUSPECT_GRACE_MS,
} from "../../src/daemon/sessionLivenessWindows";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

// After a daemon restart, a rehydrated session waits for its owner to reconnect. Rehydration
// runs before iOS services, the control socket and the heartbeat monitor start, so the owner's
// window must start when the daemon can hear from it, and it gets the lease plus the suspect
// grace, as a live owner would. The release is terminal, so a short window loses the session.

interface DaemonMonitorInternals {
  heartbeatMonitor: { stop(): void } | null;
  startHeartbeatMonitor(): void;
}

/** Startup work between rehydration and the monitor start, longer than the 4 s lease. */
const STARTUP_AFTER_REHYDRATION_MS = 6_000;
const OWNER_WINDOW_MS = DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS + SUSPECT_GRACE_MS;

async function rehydratedDaemon() {
  const timer = new FakeTimer();
  const daemon = new Daemon(
    {},
    undefined,
    timer,
    new DeviceSessionRepository(await createTestDatabase(), timer),
  );
  const sessionManager = daemon.getSessionManager();
  const internals = daemon as unknown as DaemonMonitorInternals;
  const released: string[] = [];
  const unsubscribe = SessionReleaseBroadcaster.subscribe((_sessionId, reason) => {
    released.push(reason ?? "");
  });
  await sessionManager.createSession(
    "rehydrated",
    "emulator-5554",
    "android",
    undefined,
    undefined,
    undefined,
    undefined,
    "awaiting-owner",
  );
  timer.advanceTime(STARTUP_AFTER_REHYDRATION_MS);
  internals.startHeartbeatMonitor();
  const stop = () => {
    unsubscribe();
    internals.heartbeatMonitor?.stop();
    sessionManager.stopCleanupTimer();
  };
  return { timer, sessionManager, released, stop };
}

describe("rehydrated owner reconnect window", () => {
  afterEach(() => {
    SessionReleaseBroadcaster.clearForTesting();
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    NavigationGraphManager.resetInstance();
  });

  test("an owner reconnecting late in the window keeps its session", async () => {
    const { timer, sessionManager, released, stop } = await rehydratedDaemon();
    try {
      await timer.advanceTimeAsync(OWNER_WINDOW_MS - DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS);
      expect(released).toEqual([]);
      sessionManager.recordHeartbeat("rehydrated");
      expect(sessionManager.getSession("rehydrated")?.ownership).toBe("owned");
    } finally {
      stop();
    }
  });

  test("an owner that never returns is released once the window from monitor start ends", async () => {
    const { timer, sessionManager, released, stop } = await rehydratedDaemon();
    try {
      await timer.advanceTimeAsync(OWNER_WINDOW_MS);
      expect(released).toEqual([]);
      await timer.advanceTimeAsync(DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS);
      expect(released).toEqual(["rehydration-owner-timeout"]);
      expect(sessionManager.getSession("rehydrated")).toBeNull();
    } finally {
      stop();
    }
  });
});
