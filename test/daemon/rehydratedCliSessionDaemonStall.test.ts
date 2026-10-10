import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { idleReleaseAt } from "../../src/daemon/sessionHoldDiagnostics";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
} from "../../src/daemon/sessionLivenessWindows";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

// The daemon's own stall is never held against a session (#10051, #10835). A stall moves a
// heartbeat session's lease and owner-reconnect window forward, and a cli-idle session's idle
// window forward. A REHYDRATED cli-idle session (awaiting its owner after a daemon restart) is
// judged by the monitor on its owner-reconnect window alone, so `forgiveDaemonStall` must move
// that window with the idle anchor (#11481): otherwise the first scan after a stall releases it,
// terminally, while every other session survives the same stall and while the session's own
// reported `idleReleaseAt` is still minutes away. Host sleep is not forgiven: it counts toward a
// CLI session's idle window.

const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
const CLI_IDLE_MS = 120_000;
const STALL_MS = 130_000;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe("a rehydrated cli-idle session across a daemon stall", () => {
  test("the daemon's stall is not held against it, as for every other session", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const timer = new FakeTimer();
      timer.setCurrentTime(0);
      const manager = new SessionManager(
        timer,
        new FakeDeviceSessionPersistence(),
        () => new FakeDbWriteBarrier(),
      );
      cleanups.push(() => manager.stopCleanupTimer());

      // A one-shot CLI's session, rehydrated after a daemon restart and awaiting its owner.
      await manager.createSession(
        "rehydrated-cli",
        "emulator-5554",
        "android",
        undefined,
        undefined,
        undefined,
        {
          sessionTimeoutMs: CLI_IDLE_MS,
          heartbeatTimeoutMs: CLI_IDLE_MS,
          heartbeatTimeoutSource: "default",
          hasReceivedHeartbeat: true,
          livenessPolicy: "cli-idle",
        },
        "awaiting-owner",
      );
      // Controls: a proxy's rehydrated session, and a CLI session this daemon created itself.
      await manager.createSession(
        "rehydrated-proxy",
        "emulator-5556",
        "android",
        undefined,
        undefined,
        undefined,
        {
          sessionTimeoutMs: 600_000,
          heartbeatTimeoutMs: DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
          heartbeatTimeoutSource: "default",
          hasReceivedHeartbeat: true,
          livenessPolicy: "heartbeat",
        },
        "awaiting-owner",
      );
      await manager.createSession("live-cli", "emulator-5558", "android", 60_000);
      expect(manager.adoptCliLivenessPolicy("live-cli", CLI_IDLE_MS)).toBe(true);

      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(
        manager,
        () => false,
        async (sessionId, reason) => {
          reaped.push(`${sessionId}:${reason}`);
          await manager.releaseSession(sessionId, reason);
        },
        timer,
      );
      manager.startRehydratedOwnerWindows();
      monitor.start();
      cleanups.push(() => void monitor.stop());

      // Two scans on time, then the daemon's event loop is blocked: both clocks run, no timer fires.
      await timer.advanceTimeAsync(2 * SCAN_MS, () => drainMicrotasks(10));
      expect(reaped).toEqual([]);
      const rehydratedCli = manager.getSession("rehydrated-cli")!;
      timer.setCurrentTime(timer.now() + STALL_MS);
      await monitor.tick();

      // The idle release the daemon reports for the rehydrated CLI session was moved by the
      // stall and is still more than a minute away.
      expect(idleReleaseAt(rehydratedCli)).toBeGreaterThan(timer.now() + 60_000);
      // No session is released on the strength of the daemon's own stall.
      expect(reaped).toEqual([]);
      expect(manager.getSession("rehydrated-cli")).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  test("host sleep still counts toward its window; a stall moves both clocks alike", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(0);
    const manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    cleanups.push(() => manager.stopCleanupTimer());
    await manager.createSession(
      "rehydrated-cli",
      "emulator-5554",
      "android",
      undefined,
      undefined,
      undefined,
      {
        sessionTimeoutMs: CLI_IDLE_MS,
        heartbeatTimeoutMs: CLI_IDLE_MS,
        heartbeatTimeoutSource: "default",
        hasReceivedHeartbeat: true,
        livenessPolicy: "cli-idle",
      },
      "awaiting-owner",
    );
    manager.startRehydratedOwnerWindows();
    const session = manager.getSession("rehydrated-cli")!;
    const windowStart = session.awaitingOwnerSince ?? Number.NaN;
    const idleDue = idleReleaseAt(session);

    timer.setCurrentTime(STALL_MS);
    manager.forgiveDaemonStall(STALL_MS, 0, STALL_MS, 0);
    expect(session.awaitingOwnerSince).toBe(windowStart);
    expect(idleReleaseAt(session)).toBe(idleDue);

    // The daemon's stall moves both clocks by the same amount, so the reported idle release
    // keeps matching the release the monitor makes.
    manager.forgiveDaemonStall(STALL_MS, 30_000, 0, 0);
    expect(session.awaitingOwnerSince).toBe(windowStart + 30_000);
    expect(idleReleaseAt(session)).toBe(idleDue + 30_000);
  });
});
