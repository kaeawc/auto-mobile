import { deliverDaemonHeartbeat } from "../helpers/daemonHeartbeatHandler";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  SUSPECT_GRACE_MS,
} from "../../src/daemon/wire/sessionLivenessWindows";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { SessionReleaseBroadcaster } from "../../src/daemon/sessionReleaseBroadcast";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";
import { DaemonLifecycleHarness } from "./helpers/DaemonLifecycleHarness";

// After a daemon restart, a rehydrated session waits for its owner to reconnect. Rehydration
// runs before iOS services, the control socket and the heartbeat monitor start, so the owner's
// window must start when the daemon can hear from it, and it gets the lease plus the suspect
// grace, as a live owner would. The release is terminal, so a short window loses the session.

/** Startup work between rehydration and the monitor start, longer than the 4 s lease. */
const STARTUP_AFTER_REHYDRATION_MS = 6_000;
const OWNER_WINDOW_MS = DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS + SUSPECT_GRACE_MS;

async function rehydratedDaemon() {
  const timer = new FakeTimer();
  const daemon = new DaemonLifecycleHarness(
    {},
    {
      timer,
      deviceSessionRepository: new DeviceSessionRepository(await createTestDatabase(), timer),
    },
  );
  const sessionManager = daemon.getSessionManager();
  const released: string[] = [];
  const unsubscribe = SessionReleaseBroadcaster.subscribe((_sessionId, reason) => {
    released.push(reason ?? "");
  });
  await sessionManager.createSession("rehydrated", "emulator-5554", "android", {
    initialOwnership: "awaiting-owner",
  });
  timer.advanceTime(STARTUP_AFTER_REHYDRATION_MS);
  daemon.startMonitor();
  const stop = () => {
    unsubscribe();
    daemon.stopMonitor();
    sessionManager.stopCleanupTimer();
  };
  return { timer, sessionManager, released, stop };
}

function resetSharedState(): void {
  SessionReleaseBroadcaster.clearForTesting();
  if (DaemonState.getInstance().isInitialized()) {
    DaemonState.getInstance().reset();
  }
  NavigationGraphManager.resetInstance();
}

describe("rehydrated owner reconnect window", () => {
  // beforeAll is outside the per-test budget: one full scenario pays the daemon, in-memory
  // database and monitor first-use cost that the first timed test would otherwise carry.
  beforeAll(async () => {
    const { timer, stop } = await rehydratedDaemon();
    try {
      await timer.advanceTimeAsync(OWNER_WINDOW_MS + DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS);
    } finally {
      stop();
      resetSharedState();
    }
  });

  afterEach(resetSharedState);

  test("an owner reconnecting late in the window keeps its session", async () => {
    const { timer, sessionManager, released, stop } = await rehydratedDaemon();
    try {
      await timer.advanceTimeAsync(OWNER_WINDOW_MS - DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS);
      expect(released).toEqual([]);
      await deliverDaemonHeartbeat(sessionManager, "rehydrated");
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
