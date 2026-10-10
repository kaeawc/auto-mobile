import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager, type SessionDeviceAssigner } from "../../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";

// Hunt: a rehydrated (awaiting-owner) session's owner window is restarted when the daemon can
// hear owners (startRehydratedOwnerWindows), but its idle deadline stays on the rehydration-time
// origin. Startup after rehydration (iOS services, socket bind) that outlasts the idle window
// leaves the owner a fresh reconnect window on a session that is already past its idle deadline.

const SIM = "SIM-IDLE-ORIGIN";
const AUTOLOCK_IDLE_MS = 60_000;

describe("rehydrated session idle origin", () => {
  let timer: FakeTimer;
  let persistence: FakeDeviceSessionPersistence;
  let sessions: SessionManager;

  beforeEach(async () => {
    timer = new FakeTimer();
    persistence = new FakeDeviceSessionPersistence();
    await persistence.upsertActiveSession({
      sessionUuid: "row-idle",
      deviceId: SIM,
      stableDeviceId: SIM,
      platform: "ios",
      createdAtMs: 0,
      lastUsedAtMs: 0,
      expiresAtMs: 10 * 60_000,
      sessionTimeoutMs: AUTOLOCK_IDLE_MS,
      heartbeatTimeoutMs: 10_000,
      hasReceivedHeartbeat: true,
    });
    await persistence.markReleased("row-idle", "released", 0, "daemon-restart");
    sessions = new SessionManager(timer, persistence);
  });

  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  test("owner window restart also restarts the idle deadline of a rehydrated session", async () => {
    const pool: SessionDeviceAssigner = {
      async assignDeviceToSession(sessionId, _platform, target): Promise<string> {
        const session = await sessions.createSession(
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
    await sessions.rehydratePersistedSessions(pool, { concurrency: 1 });
    const rehydrated = sessions.getSession("row-idle");
    expect(rehydrated?.ownership).toBe("awaiting-owner");
    expect(rehydrated?.expiresAt).toBe(AUTOLOCK_IDLE_MS);

    // Startup between rehydration and the control socket takes longer than the idle window.
    await timer.advanceTimeAsync(AUTOLOCK_IDLE_MS - 1_000);
    expect(sessions.startRehydratedOwnerWindows()).toBe(1);
    await timer.advanceTimeAsync(2_000);

    // 2 s into the restarted owner window (lease 10 s + 4 s grace) the owner may still return,
    // but the session is already past its idle deadline and lazily expires.
    expect(sessions.getSession("row-idle")).not.toBeNull();
  });
});
