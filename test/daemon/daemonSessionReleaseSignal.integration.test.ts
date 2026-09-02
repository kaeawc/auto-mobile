import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { deviceLossCancellationReason } from "../../src/daemon/emulatorLossIncident";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { NavigationRepository } from "../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../src/db/testCoverageRepository";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

// Issue #4610: the daemon registers a release callback (next to the nav-graph /
// observe-cache cleanup) that fans the released session key out to the
// SessionReleaseBroadcaster, so a connected proxy learns of a real release
// instead of guessing with the replay TTL.

interface DaemonHeartbeatMonitorInternals {
  heartbeatMonitor: { stop(): void } | null;
  startHeartbeatMonitor(): void;
}

interface DaemonSessionReleaseInternals {
  cancelAndReleaseSession(sessionId: string, releaseReason: string): Promise<void>;
}

describe("Daemon session-release signal wiring", () => {
  afterEach(() => {
    SessionReleaseBroadcaster.clearForTesting();
    // Constructing a Daemon initializes the global DaemonState singleton; reset
    // it so this file does not leak initialized state into other suites.
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    NavigationGraphManager.resetInstance();
  });

  test("emits the released session key to the broadcaster on releaseSession", async () => {
    // Inject an in-memory migrated DB so createSession/releaseSession persist
    // through DeviceSessionRepository without resolving the real ~/.auto-mobile
    // file DB (CLAUDE.md unit-test guard, issue #3067). The Daemon threads this
    // repository straight into its SessionManager (daemon.ts).
    const db = await createTestDatabase();
    const daemon = new Daemon({}, undefined, undefined, new DeviceSessionRepository(db));
    const sessionManager = daemon.getSessionManager();

    const emitted: Array<{ sessionId: string; reason?: string }> = [];
    const unsubscribe = SessionReleaseBroadcaster.subscribe((sessionId, reason) => {
      emitted.push({ sessionId, reason });
    });

    try {
      await sessionManager.createSession("session-release-signal", "emulator-5554", "android");
      await sessionManager.releaseSession("session-release-signal");

      expect(emitted).toEqual([
        { sessionId: "session-release-signal", reason: "explicit-release" },
      ]);
    } finally {
      unsubscribe();
      sessionManager.stopCleanupTimer();
    }
  });

  test("heartbeat monitor persists and broadcasts the diagnostic expiry reason", async () => {
    const db = await createTestDatabase();
    const timer = new FakeTimer();
    const repository = new DeviceSessionRepository(db);
    const daemon = new Daemon({}, undefined, timer, repository);
    const sessionManager = daemon.getSessionManager();
    const internals = daemon as unknown as DaemonHeartbeatMonitorInternals;
    const emitted: Array<{ sessionId: string; reason?: string }> = [];
    const unsubscribe = SessionReleaseBroadcaster.subscribe((sessionId, reason) => {
      emitted.push({ sessionId, reason });
    });

    try {
      await sessionManager.createSession(
        "heartbeat-expired",
        "emulator-5554",
        "android",
        60_000,
        1_000,
      );
      sessionManager.recordHeartbeat("heartbeat-expired");
      internals.startHeartbeatMonitor();

      await timer.advanceTimeAsync(10_000);

      const persisted = await repository.getSession("heartbeat-expired");
      expect(persisted).toMatchObject({
        status: "expired",
        release_reason: "heartbeat-timeout",
      });
      expect(emitted).toEqual([{ sessionId: "heartbeat-expired", reason: "heartbeat-timeout" }]);
    } finally {
      unsubscribe();
      internals.heartbeatMonitor?.stop();
      sessionManager.stopCleanupTimer();
    }
  });

  test("does not publish a terminal release before persistence succeeds", async () => {
    const db = await createTestDatabase();
    const repository = new DeviceSessionRepository(db);
    const daemon = new Daemon({}, undefined, undefined, repository);
    const sessionManager = daemon.getSessionManager();
    const devicePool = daemon.getDevicePool();
    const internals = daemon as unknown as DaemonSessionReleaseInternals;
    const sessionId = "terminal-persistence-failure";
    const deviceId = "physical-device";
    const emitted: string[] = [];
    const unsubscribe = SessionReleaseBroadcaster.subscribe((releasedSessionId) => {
      emitted.push(releasedSessionId);
    });
    const markReleasedSpy = spyOn(repository, "markReleased").mockRejectedValue(
      new Error("database unavailable"),
    );

    try {
      await devicePool.initializeWithDevices([
        {
          name: "Pixel",
          deviceId,
          platform: "android",
        },
      ]);
      await devicePool.assignDeviceToSession(sessionId, "android");

      await expect(
        internals.cancelAndReleaseSession(
          sessionId,
          deviceLossCancellationReason(deviceId, "incident-1"),
        ),
      ).rejects.toThrow("Failed to persist terminal release");

      expect(sessionManager.getSession(sessionId)).toBeNull();
      expect(sessionManager.getTerminalReleaseSnapshot(sessionId)).toMatchObject({
        deviceId,
        releaseReason: deviceLossCancellationReason(deviceId, "incident-1"),
        terminal: true,
      });
      expect(devicePool.getDevice(deviceId)).toMatchObject({
        sessionId,
        status: "busy",
      });
      expect(emitted).toEqual([]);

      markReleasedSpy.mockResolvedValue(undefined);
      await internals.cancelAndReleaseSession(
        sessionId,
        deviceLossCancellationReason(deviceId, "incident-1"),
      );
      expect(sessionManager.getSession(sessionId)).toBeNull();
      expect(devicePool.getDevice(deviceId)).toMatchObject({ sessionId: null, status: "idle" });
      expect(emitted).toEqual([sessionId]);
    } finally {
      unsubscribe();
      markReleasedSpy.mockRestore();
      sessionManager.stopCleanupTimer();
      await db.destroy();
    }
  });

  test("resets navigation state when a live session rebinds to another device", async () => {
    const db = await createTestDatabase();
    NavigationGraphManager.setInstanceForSessionForTesting(
      "session-rebind-navigation",
      NavigationGraphManager.createForTesting(
        new NavigationRepository(db),
        new TestCoverageRepository(undefined, db),
        undefined,
        "session-rebind-navigation",
      ),
    );
    const daemon = new Daemon({}, undefined, undefined, new DeviceSessionRepository(db));
    const sessionManager = daemon.getSessionManager();

    try {
      await sessionManager.createSession("session-rebind-navigation", "emulator-old", "android");
      const oldNavigation = NavigationGraphManager.getInstanceForSession(
        "session-rebind-navigation",
      );
      await oldNavigation.setCurrentApp("com.example.old");

      await sessionManager.rebindSession("session-rebind-navigation", "emulator-new", "android");

      const reboundNavigation = NavigationGraphManager.getInstanceForSession(
        "session-rebind-navigation",
      );
      expect(reboundNavigation).not.toBe(oldNavigation);
      expect(reboundNavigation.getCurrentAppId()).toBeNull();
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });
});
