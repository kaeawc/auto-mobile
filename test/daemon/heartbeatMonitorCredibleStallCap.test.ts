import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  MAX_CREDIBLE_DAEMON_STALL_MS,
  SessionHeartbeatMonitor,
} from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS } from "../../src/daemon/sessionLivenessWindows";
import { logger } from "../../src/utils/logger";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #10962 (owner decision 2026-10-09): where the monotonic clock runs through host sleep (Linux,
// Windows) a credible daemon stall is capped at a fixed 30 s, independent of the idle window. Any
// longer gap is host sleep and counts toward idle. Plus a self-check for clock-semantics drift.

const SESSION = "credible-stall-session";
const DEVICE = "emulator-5554";
const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
const DEFAULT_IDLE_MS = 120_000;
const AUTOLOCK_IDLE_MS = 60_000;

let monitor: SessionHeartbeatMonitor | undefined;
let manager: SessionManager | undefined;

afterEach(async () => {
  await monitor?.stop();
  manager?.stopCleanupTimer();
  monitor = undefined;
  manager = undefined;
});

/** A monitor with its DEFAULT stall cap (no maxCredibleStallMs) on a Linux-model clock. */
async function linuxModel(idleMs: number, bunVersion = "1.3.14", timer = new FakeTimer()) {
  if (!timer.monotonicIncludesHostSleep) {
    timer.simulateSleepCountingMonotonicClock();
  }
  manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const sessions = manager;
  monitor = new SessionHeartbeatMonitor(
    sessions,
    () => false,
    async (sessionId, reason) => {
      await sessions.releaseSession(sessionId, reason);
    },
    timer,
    { bunVersion },
  );
  const session = await sessions.createSession(SESSION, DEVICE, "android", idleMs);
  monitor.start();
  return { timer, manager: sessions, monitor, session };
}

describe("credible daemon stall cap on a sleep-counting clock (#10962)", () => {
  test("defaults to 30 s, not the idle window", () => {
    expect(MAX_CREDIBLE_DAEMON_STALL_MS).toBe(30_000);
  });

  test("a 90 s gap counts toward idle under the 2-minute window", async () => {
    const { timer, monitor, session } = await linuxModel(DEFAULT_IDLE_MS);
    const expiresAt = session.expiresAt;
    timer.simulateHostSleep(90_000);
    await monitor.tick();
    expect(session.expiresAt).toBe(expiresAt);
  });

  test("a 20 s gap is forgiven as a daemon stall", async () => {
    const { timer, monitor, session } = await linuxModel(DEFAULT_IDLE_MS);
    const expiresAt = session.expiresAt;
    timer.simulateHostSleep(20_000);
    await monitor.tick();
    expect(session.expiresAt).toBe(expiresAt + 20_000 - SCAN_MS);
  });

  test("a 60 s autolock window is never extended by more than 30 s, at any gap", async () => {
    for (let gapMs = 0; gapMs <= 150_000; gapMs += 2_500) {
      const { timer, monitor, manager, session } = await linuxModel(AUTOLOCK_IDLE_MS);
      const expiresAt = session.expiresAt;
      timer.simulateHostSleep(gapMs);
      await monitor.tick();
      expect(session.expiresAt - expiresAt).toBeLessThanOrEqual(MAX_CREDIBLE_DAEMON_STALL_MS);
      await monitor.stop();
      manager.stopCleanupTimer();
    }
  });

  test("the verdict at the 30 s boundary does not depend on whether a lookup or the scan sees it first", async () => {
    // Invariant 3 (order independence): the lazy lookup and the scan judge the same gap the same.
    for (const lateMs of [MAX_CREDIBLE_DAEMON_STALL_MS, MAX_CREDIBLE_DAEMON_STALL_MS + 1]) {
      const results: number[] = [];
      for (const lookupFirst of [true, false]) {
        const { timer, monitor, manager, session } = await linuxModel(AUTOLOCK_IDLE_MS);
        const expiresAt = session.expiresAt;
        timer.simulateHostSleep(lateMs + SCAN_MS);
        if (lookupFirst) {
          manager.getSession(SESSION);
        }
        await monitor.tick();
        results.push(session.expiresAt - expiresAt);
        await monitor.stop();
        manager.stopCleanupTimer();
      }
      expect(results[0]).toBe(results[1]);
      expect(results[0]).toBe(lateMs <= MAX_CREDIBLE_DAEMON_STALL_MS ? lateMs : 0);
    }
  });
});

describe("clock-semantics self-check (#10962)", () => {
  test("warns at startup when the running Bun is not the verified release line", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await linuxModel(DEFAULT_IDLE_MS, "1.4.2");
      expect(warn.mock.calls.some((call) => String(call[0]).includes("Bun 1.4.2"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("is silent on the verified release line", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await linuxModel(DEFAULT_IDLE_MS, "1.3.14");
      expect(warn.mock.calls.some((call) => String(call[0]).includes("#10962"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("warns once when a clock flagged as running through sleep is measured pausing", async () => {
    // Configured as sleep-counting, but the monotonic clock actually stood still during sleep.
    class MisjudgedClock extends FakeTimer {
      private paused = 0;
      override get monotonicIncludesHostSleep(): boolean {
        return true;
      }
      override monotonicNow(): number {
        return this.now() - this.paused;
      }
      sleepWithPausedMonotonic(ms: number): void {
        this.simulateHostSleep(ms);
        this.paused += ms;
      }
    }
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const timer = new MisjudgedClock();
      const { monitor } = await linuxModel(DEFAULT_IDLE_MS, "1.3.14", timer);
      timer.sleepWithPausedMonotonic(20_000);
      await monitor.tick();
      timer.sleepWithPausedMonotonic(20_000);
      await monitor.tick();
      const disagreements = warn.mock.calls.filter((call) =>
        String(call[0]).includes("ahead of the monotonic clock"),
      );
      expect(disagreements).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
