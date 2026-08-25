import { afterEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";

// Issue #5689 (Evidence): a session reaped for `missing-first-heartbeat` is
// released under the pre-first-heartbeat grace (5s), NOT its heartbeat timeout
// (10s). The release snapshot previously reported `timeoutMs` as the heartbeat
// timeout, so a reader saw `ageMs < timeoutMs` and concluded the daemon reaped
// early. The snapshot must report the grace that actually fired.

const GRACE_ENV_KEYS = [
  "AUTOMOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
  "AUTO_MOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
] as const;

function clearGraceEnv(): void {
  for (const key of GRACE_ENV_KEYS) {
    delete process.env[key];
  }
}

describe("release snapshot reports the deadline that fired (issue #5689)", () => {
  afterEach(() => {
    clearGraceEnv();
  });

  test("a missing-first-heartbeat release reports the pre-first-heartbeat grace, not the heartbeat timeout", async () => {
    clearGraceEnv();
    const timer = new FakeTimer();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    try {
      // Default heartbeat policy: heartbeat timeout defaults to 10s.
      await manager.createSession("session-nfh", "emulator-5554", "android", 60_000);
      // Reaped after the 5s pre-first-heartbeat grace elapsed.
      timer.advanceTime(5_963);
      await manager.releaseSession("session-nfh", "missing-first-heartbeat");

      const snapshot = manager.getTerminalReleaseSnapshot("session-nfh");
      expect(snapshot?.releaseReason).toBe("missing-first-heartbeat");
      expect(snapshot?.heartbeat.hasReceivedHeartbeat).toBe(false);
      // The operative deadline is the 5s grace, not the 10s heartbeat timeout.
      expect(snapshot?.heartbeat.timeoutMs).toBe(5_000);
      // The reported deadline is now coherent with the reaping age.
      expect(snapshot!.heartbeat.ageMs).toBeGreaterThan(snapshot!.heartbeat.timeoutMs);
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("honors an overridden pre-first-heartbeat grace", async () => {
    process.env.AUTOMOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS = "3000";
    const timer = new FakeTimer();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    try {
      await manager.createSession("session-nfh2", "emulator-5554", "android", 60_000);
      timer.advanceTime(3_500);
      await manager.releaseSession("session-nfh2", "missing-first-heartbeat");

      expect(manager.getTerminalReleaseSnapshot("session-nfh2")?.heartbeat.timeoutMs).toBe(3_000);
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("a heartbeat-timeout release still reports the session heartbeat timeout", async () => {
    clearGraceEnv();
    const timer = new FakeTimer();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    try {
      // Explicit heartbeat timeout of 2s (custom source).
      await manager.createSession("session-hbt", "emulator-5554", "android", 60_000, 2_000);
      timer.advanceTime(3_000);
      await manager.releaseSession("session-hbt", "heartbeat-timeout");

      expect(manager.getTerminalReleaseSnapshot("session-hbt")?.heartbeat.timeoutMs).toBe(2_000);
    } finally {
      manager.stopCleanupTimer();
    }
  });
});
