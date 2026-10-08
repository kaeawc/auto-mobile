import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { executionTracker } from "../../src/server/executionTracker";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

// Owner decision 2026-10-08: a session's idle window counts from the END of its last tool call.
// The daemon wires the execution tracker's end-of-execution signal to the session manager.

interface DaemonSessionTimerInternals {
  stopSessionTimers(): void;
}

describe("Daemon tool-call-end idle wiring", () => {
  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    NavigationGraphManager.resetInstance();
  });

  test("the end of a session's tool call restarts its idle window from that moment", async () => {
    const timer = new FakeTimer();
    const daemon = new Daemon(
      {},
      undefined,
      timer,
      new DeviceSessionRepository(await createTestDatabase(), timer),
    );
    const sessionManager = daemon.getSessionManager();
    const internals = daemon as unknown as DaemonSessionTimerInternals;
    try {
      const session = await sessionManager.createSession(
        "tool-call-end-wiring",
        "emulator-5554",
        "android",
      );
      const createdExpiry = session.expiresAt;

      const execution = executionTracker.startExecution(
        "tapOn",
        undefined,
        "tool-call-end-wiring",
      );
      timer.advanceTime(90_000);
      executionTracker.endExecution(execution.id);

      expect(session.lastUsedAt).toBe(90_000);
      expect(session.expiresAt).toBe(90_000 + session.sessionTimeoutMs);
      expect(session.expiresAt).toBeGreaterThan(createdExpiry);

      // Shutdown unsubscribes: a later call end no longer reaches this daemon's sessions.
      internals.stopSessionTimers();
      const afterStop = executionTracker.startExecution("tapOn", undefined, "tool-call-end-wiring");
      timer.advanceTime(10_000);
      executionTracker.endExecution(afterStop.id);
      expect(session.lastUsedAt).toBe(90_000);
    } finally {
      internals.stopSessionTimers();
    }
  });
});
