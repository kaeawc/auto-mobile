import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  MAX_CREDIBLE_DAEMON_STALL_MS,
  SessionHeartbeatMonitor,
} from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS } from "../../src/daemon/wire/sessionLivenessWindows";
import { logger } from "../../src/utils/logger";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { monotonicClockIncludesHostSleep } from "../../src/utils/SystemTimer";

// #10962 (owner decision 2026-10-09): where the monotonic clock runs through host sleep (Windows;
// Linux too before Bun 1.4) a credible daemon stall is capped at a fixed 30 s, independent of the idle window. Any
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

/** A monitor with its DEFAULT stall cap (no maxCredibleStallMs) on the given clock. */
async function monitorOn(timer: FakeTimer, idleMs: number, bunVersion: string) {
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
  const session = await sessions.createSession(SESSION, DEVICE, "android", { timeoutMs: idleMs });
  monitor.start();
  return { timer, manager: sessions, monitor, session };
}

/** A monitor with its DEFAULT stall cap on a sleep-counting (Windows) clock. */
async function sleepCountingModel(idleMs: number, bunVersion = "1.4.4", timer = new FakeTimer()) {
  if (!timer.monotonicIncludesHostSleep) {
    timer.simulateSleepCountingMonotonicClock();
  }
  return monitorOn(timer, idleMs, bunVersion);
}

describe("credible daemon stall cap on a sleep-counting clock (#10962)", () => {
  test("defaults to 30 s, not the idle window", () => {
    expect(MAX_CREDIBLE_DAEMON_STALL_MS).toBe(30_000);
  });

  test("a 90 s gap counts toward idle under the 2-minute window", async () => {
    const { timer, monitor, session } = await sleepCountingModel(DEFAULT_IDLE_MS);
    const expiresAt = session.expiresAt;
    timer.simulateHostSleep(90_000);
    await monitor.tick();
    expect(session.expiresAt).toBe(expiresAt);
  });

  test("a 20 s gap is forgiven as a daemon stall", async () => {
    const { timer, monitor, session } = await sleepCountingModel(DEFAULT_IDLE_MS);
    const expiresAt = session.expiresAt;
    timer.simulateHostSleep(20_000);
    await monitor.tick();
    expect(session.expiresAt).toBe(expiresAt + 20_000 - SCAN_MS);
  });

  test("a 60 s autolock window is never extended by more than 30 s, at any gap", async () => {
    for (let gapMs = 0; gapMs <= 150_000; gapMs += 2_500) {
      const { timer, monitor, manager, session } = await sleepCountingModel(AUTOLOCK_IDLE_MS);
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
        const { timer, monitor, manager, session } = await sleepCountingModel(AUTOLOCK_IDLE_MS);
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
      await sleepCountingModel(DEFAULT_IDLE_MS, "1.3.14");
      expect(warn.mock.calls.some((call) => String(call[0]).includes("Bun 1.3.14"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("is silent on the verified release line", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await sleepCountingModel(DEFAULT_IDLE_MS, "1.4.4");
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
      const { monitor } = await sleepCountingModel(DEFAULT_IDLE_MS, "1.4.4", timer);
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

describe("Linux clock under Bun 1.4 (#14979)", () => {
  /** A FakeTimer with the clock semantics the platform table assigns to Linux. */
  function linuxClock(): FakeTimer {
    const timer = new FakeTimer();
    if (monotonicClockIncludesHostSleep("linux")) {
      timer.simulateSleepCountingMonotonicClock();
    }
    return timer;
  }

  test("a 20 s host sleep counts toward idle instead of being forgiven as a daemon stall", async () => {
    const { timer, monitor, session } = await monitorOn(linuxClock(), DEFAULT_IDLE_MS, "1.4.4");
    const expiresAt = session.expiresAt;
    timer.simulateHostSleep(20_000);
    await monitor.tick();
    expect(session.expiresAt).toBe(expiresAt);
  });

  test("a 90 s daemon stall is still forgiven past the sleep-counting 30 s cap", async () => {
    const { timer, monitor, session } = await monitorOn(linuxClock(), DEFAULT_IDLE_MS, "1.4.4");
    const expiresAt = session.expiresAt;
    timer.setCurrentTime(timer.now() + 90_000);
    await monitor.tick();
    expect(session.expiresAt).toBeGreaterThan(expiresAt + MAX_CREDIBLE_DAEMON_STALL_MS);
  });
});
