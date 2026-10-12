import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeDatabaseInitializer } from "../fakes/FakeDatabaseInitializer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeStartupFailureTracker } from "../fakes/FakeStartupFailureTracker";
import { FakeTimer } from "../fakes/FakeTimer";

import { logger } from "../../src/utils/logger";

import { DatabaseHealthProbeTimeoutError } from "../../src/db/DatabaseHealthProbe";

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const MAX_FAILED_CHECKS = 3;

interface FakeSocketServer {
  isListening(): boolean;
}

interface FakeObservationStreamHealth {
  isHealthy(): boolean;
  recover(): Promise<void>;
}

interface DaemonHealthInternals {
  httpServer: { listening: boolean } | null;
  socketServer: FakeSocketServer | null;
  observationStreamHealth: FakeObservationStreamHealth;
  healthCheckTimer: NodeJS.Timeout | null;
  lastDatabaseHealthFailure?: string;
  startHealthCheckTimer(): void;
  stopHealthCheckTimer(): void;
  attemptRecovery(failureKind?: string): Promise<void>;
}

class FakeDatabaseHealthProbe {
  checkCalls = 0;
  beforeReject: () => void = () => {};
  private error: Error | null = null;

  failWith(error: Error): void {
    this.error = error;
  }

  succeed(): void {
    this.error = null;
  }

  async check(): Promise<void> {
    this.checkCalls += 1;
    if (this.error) {
      this.beforeReject();
      throw this.error;
    }
  }
}

function buildDaemon(
  timer: FakeTimer,
  databaseHealthProbe: FakeDatabaseHealthProbe,
  exitProcess: (code: number) => Promise<void> | void = () => {},
): Daemon {
  const daemon = new Daemon(
    {},
    new FakeInstalledAppsRepository(),
    timer,
    undefined,
    new CountingIdGenerator("daemon-session"),
    new FakeDatabaseInitializer(),
    new FakeStartupFailureTracker(),
    databaseHealthProbe,
    exitProcess,
  );
  (daemon as unknown as DaemonHealthInternals).observationStreamHealth = {
    isHealthy: () => true,
    recover: async () => {},
  };
  return daemon;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Daemon database health check", () => {
  let cleanup: { internals: DaemonHealthInternals; timer: FakeTimer } | null = null;

  afterEach(() => {
    if (cleanup?.internals.healthCheckTimer) {
      cleanup.timer.clearInterval(cleanup.internals.healthCheckTimer);
      cleanup = null;
    }
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  function timeoutHarness() {
    const timer = new FakeTimer();
    const probe = new FakeDatabaseHealthProbe();
    probe.failWith(new DatabaseHealthProbeTimeoutError(1000));
    const exits: Array<{ code: number; detail?: string }> = [];
    const daemon = buildDaemon(timer, probe, (code: number, detail?: string) => {
      exits.push({ code, detail });
    });
    const internals = daemon as unknown as DaemonHealthInternals;
    cleanup = { internals, timer };
    internals.httpServer = { listening: true };
    internals.socketServer = { isListening: () => true };
    internals.startHealthCheckTimer();
    // Move past the schedule before firing; async advance preserves the late reading.
    const tick = async (lateMs = 0) => {
      timer.setCurrentTime(timer.now() + HEALTH_CHECK_INTERVAL_MS + lateMs);
      await timer.advanceTimeAsync(0, flushMicrotasks);
    };
    return { timer, probe, exits, internals, tick };
  }

  test("three on-time typed timeouts exit once with the timeout detail", async () => {
    const h = timeoutHarness();
    for (let i = 0; i < 3; i++) {
      await h.tick();
    }
    expect(h.exits).toEqual([{ code: 1, detail: "Database health probe timed out after 1000ms" }]);
  });

  test("three late-tick timeouts are inconclusive", async () => {
    const h = timeoutHarness();
    for (let i = 0; i < 3; i++) {
      await h.tick(3000);
    }
    expect(h.probe.checkCalls).toBe(3);
    expect(h.exits).toEqual([]);
  });

  test("an inconclusive timeout neither increments nor resets two strikes", async () => {
    const h = timeoutHarness();
    await h.tick();
    await h.tick();
    await h.tick(3000);
    expect(h.exits).toEqual([]);
    await h.tick();
    expect(h.exits).toHaveLength(1);
  });

  test("probe overruns on on-time ticks are inconclusive", async () => {
    const h = timeoutHarness();
    h.probe.beforeReject = () => h.timer.setCurrentTime(h.timer.now() + 4000);
    for (let i = 0; i < 3; i++) {
      await h.tick();
    }
    expect(h.exits).toEqual([]);
  });

  test("real database errors count even on late ticks", async () => {
    const h = timeoutHarness();
    h.probe.failWith(new Error("database disk image is malformed"));
    for (let i = 0; i < 3; i++) {
      await h.tick(3000);
    }
    expect(h.exits).toEqual([{ code: 1, detail: "database disk image is malformed" }]);
  });

  test.each([2000, 2001])("tick lateness boundary of %ims", async (lateMs) => {
    const h = timeoutHarness();
    for (let i = 0; i < 3; i++) {
      await h.tick(lateMs);
    }
    expect(h.exits).toHaveLength(lateMs === 2000 ? 1 : 0);
  });

  test("one warning names the measurements and preserves the current strike count", async () => {
    const h = timeoutHarness();
    await h.tick();
    const warnings = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      h.probe.beforeReject = () => h.timer.setCurrentTime(h.timer.now() + 4000);
      await h.tick(3001);
      expect(warnings).toHaveBeenCalledTimes(1);
      const message = String(warnings.mock.calls[0]![0]);
      expect(message).toContain("inconclusive");
      expect(message).toContain("tick lateness=3001ms");
      expect(message).toContain("probe overrun=3000ms");
      expect(message).toContain("timeout=1000ms");
      expect(message).toContain("strike count stays at 1");
      expect(message).not.toContain("Database probe failed");
    } finally {
      warnings.mockRestore();
    }
  });

  test("host sleep spanning a timeout is inconclusive", async () => {
    const h = timeoutHarness();
    h.probe.beforeReject = () => h.timer.simulateHostSleep(3001);
    for (let i = 0; i < 3; i++) {
      await h.tick();
    }
    expect(h.exits).toEqual([]);
  });

  test("a sleep-counting clock reports a gap beyond the credible cap as sleep", async () => {
    const h = timeoutHarness();
    h.timer.simulateSleepCountingMonotonicClock();
    const warnings = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      h.timer.simulateHostSleep(60001);
      await h.timer.advanceTimeAsync(0, flushMicrotasks);
      expect(h.exits).toEqual([]);
      expect(String(warnings.mock.calls[0]![0])).toContain("tick host sleep=30001ms");
      expect(String(warnings.mock.calls[0]![0])).toContain("tick lateness=0ms");
    } finally {
      warnings.mockRestore();
    }
  });

  test("inconclusive failures do not overwrite the last counted recovery detail", async () => {
    const h = timeoutHarness();
    h.probe.failWith(new DatabaseHealthProbeTimeoutError(1111));
    await h.tick();
    await h.tick();
    h.probe.failWith(new DatabaseHealthProbeTimeoutError(2222));
    await h.tick(3000);
    expect(h.internals.lastDatabaseHealthFailure).toBe(
      "Database health probe timed out after 1111ms",
    );
    expect(h.exits).toEqual([]);
    h.probe.failWith(new DatabaseHealthProbeTimeoutError(3333));
    await h.tick();
    expect(h.exits).toEqual([{ code: 1, detail: "Database health probe timed out after 3333ms" }]);
  });

  test("counts a wedged database probe toward recovery within the existing failure budget", async () => {
    const timer = new FakeTimer();
    const databaseHealthProbe = new FakeDatabaseHealthProbe();
    databaseHealthProbe.failWith(new Error("SQLITE_BUSY: database is locked"));
    const daemon = buildDaemon(timer, databaseHealthProbe);
    const internals = daemon as unknown as DaemonHealthInternals;
    cleanup = { internals, timer };
    const recoveryCalls: Array<{ at: number; failureKind?: string }> = [];

    internals.httpServer = { listening: true };
    internals.socketServer = { isListening: () => true };
    internals.attemptRecovery = async (failureKind) => {
      recoveryCalls.push({ at: timer.now(), failureKind });
    };

    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    }

    expect(databaseHealthProbe.checkCalls).toBe(MAX_FAILED_CHECKS);
    expect(recoveryCalls).toEqual([
      {
        at: HEALTH_CHECK_INTERVAL_MS * MAX_FAILED_CHECKS,
        failureKind: "database",
      },
    ]);
  });

  test("exits the daemon when repeated database probe failures reach recovery", async () => {
    const timer = new FakeTimer();
    const databaseHealthProbe = new FakeDatabaseHealthProbe();
    databaseHealthProbe.failWith(new Error("database disk image is malformed"));
    const exitCodes: number[] = [];
    const daemon = buildDaemon(timer, databaseHealthProbe, (code) => {
      exitCodes.push(code);
    });
    const internals = daemon as unknown as DaemonHealthInternals;
    cleanup = { internals, timer };

    internals.httpServer = { listening: true };
    internals.socketServer = { isListening: () => true };
    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    }

    expect(exitCodes).toEqual([1]);
  });

  test("passes the last database probe failure to exit recovery", async () => {
    const timer = new FakeTimer();
    const databaseHealthProbe = new FakeDatabaseHealthProbe();
    databaseHealthProbe.failWith(new Error("SQLITE_BUSY: database is locked"));
    const recoveryCalls: Array<{ code: number; detail?: string }> = [];
    const daemon = buildDaemon(timer, databaseHealthProbe, (code: number, detail?: string) => {
      recoveryCalls.push({ code, detail });
    });
    const internals = daemon as unknown as DaemonHealthInternals;
    cleanup = { internals, timer };

    internals.httpServer = { listening: true };
    internals.socketServer = { isListening: () => true };
    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    }

    expect(recoveryCalls).toEqual([
      { code: 1, detail: expect.stringContaining("SQLITE_BUSY: database is locked") },
    ]);
  });

  test("clears the previous database probe failure after a passing probe", async () => {
    const timer = new FakeTimer();
    const databaseHealthProbe = new FakeDatabaseHealthProbe();
    databaseHealthProbe.failWith(new Error("first failure"));
    const recoveryCalls: Array<{ code: number; detail?: string }> = [];
    const daemon = buildDaemon(timer, databaseHealthProbe, (code: number, detail?: string) => {
      recoveryCalls.push({ code, detail });
    });
    const internals = daemon as unknown as DaemonHealthInternals;
    cleanup = { internals, timer };

    internals.httpServer = { listening: true };
    internals.socketServer = { isListening: () => true };
    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS - 1; i += 1) {
      await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    }

    databaseHealthProbe.succeed();
    await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);

    databaseHealthProbe.failWith(new Error("second failure"));
    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    }

    expect(databaseHealthProbe.checkCalls).toBe(6);
    expect(recoveryCalls).toEqual([{ code: 1, detail: expect.stringContaining("second failure") }]);
    expect(recoveryCalls[0]!.detail).not.toContain("first failure");
  });

  test("awaits asynchronous database recovery before completing recovery", async () => {
    const timer = new FakeTimer();
    const databaseHealthProbe = new FakeDatabaseHealthProbe();
    const recoveryCodes: number[] = [];
    let finishRecovery!: () => void;
    const daemon = buildDaemon(timer, databaseHealthProbe, async (code) => {
      recoveryCodes.push(code);
      await new Promise<void>((resolve) => {
        finishRecovery = resolve;
      });
    });
    const internals = daemon as unknown as DaemonHealthInternals;

    const recovery = internals.attemptRecovery("database");
    await flushMicrotasks();

    expect(recoveryCodes).toEqual([1]);
    let recoveryCompleted = false;
    void recovery.then(() => {
      recoveryCompleted = true;
    });
    await flushMicrotasks();
    expect(recoveryCompleted).toBe(false);

    finishRecovery();
    await recovery;
    expect(recoveryCompleted).toBe(true);
  });

  test("does not exit for database recovery after mixed health failure kinds", async () => {
    const timer = new FakeTimer();
    const databaseHealthProbe = new FakeDatabaseHealthProbe();
    databaseHealthProbe.failWith(new Error("database disk image is malformed"));
    const exitCodes: number[] = [];
    const daemon = buildDaemon(timer, databaseHealthProbe, (code) => {
      exitCodes.push(code);
    });
    const internals = daemon as unknown as DaemonHealthInternals;
    cleanup = { internals, timer };

    internals.httpServer = { listening: false };
    internals.socketServer = { isListening: () => true };
    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS - 1; i += 1) {
      await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    }

    internals.httpServer = { listening: true };
    await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);

    expect(databaseHealthProbe.checkCalls).toBe(1);
    expect(exitCodes).toEqual([]);

    for (let i = 0; i < MAX_FAILED_CHECKS - 1; i += 1) {
      await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    }

    expect(databaseHealthProbe.checkCalls).toBe(MAX_FAILED_CHECKS);
    expect(exitCodes).toEqual([1]);
  });

  test("does not exit for database recovery after mixed http socket and database failures", async () => {
    const timer = new FakeTimer();
    const databaseHealthProbe = new FakeDatabaseHealthProbe();
    databaseHealthProbe.failWith(new Error("database disk image is malformed"));
    const exitCodes: number[] = [];
    const daemon = buildDaemon(timer, databaseHealthProbe, (code) => {
      exitCodes.push(code);
    });
    const internals = daemon as unknown as DaemonHealthInternals;
    cleanup = { internals, timer };

    internals.httpServer = { listening: false };
    internals.socketServer = { isListening: () => true };
    internals.startHealthCheckTimer();

    await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);

    internals.httpServer = { listening: true };
    internals.socketServer = { isListening: () => false };
    await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);

    internals.socketServer = { isListening: () => true };
    await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);

    expect(databaseHealthProbe.checkCalls).toBe(1);
    expect(exitCodes).toEqual([]);

    for (let i = 0; i < MAX_FAILED_CHECKS - 1; i += 1) {
      await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    }

    expect(databaseHealthProbe.checkCalls).toBe(MAX_FAILED_CHECKS);
    expect(exitCodes).toEqual([1]);
  });

  test("counts repeated HTTP failures as HTTP recovery without probing socket or database health", async () => {
    const timer = new FakeTimer();
    const databaseHealthProbe = new FakeDatabaseHealthProbe();
    const daemon = buildDaemon(timer, databaseHealthProbe);
    const internals = daemon as unknown as DaemonHealthInternals;
    cleanup = { internals, timer };
    const recoveryCalls: Array<{ at: number; failureKind?: string }> = [];
    let observationHealthChecks = 0;

    internals.httpServer = { listening: false };
    internals.socketServer = { isListening: () => true };
    internals.observationStreamHealth = {
      isHealthy: () => {
        observationHealthChecks += 1;
        return true;
      },
      recover: async () => {},
    };
    internals.attemptRecovery = async (failureKind) => {
      recoveryCalls.push({ at: timer.now(), failureKind });
    };

    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    }

    expect(observationHealthChecks).toBe(0);
    expect(databaseHealthProbe.checkCalls).toBe(0);
    expect(recoveryCalls).toEqual([
      {
        at: HEALTH_CHECK_INTERVAL_MS * MAX_FAILED_CHECKS,
        failureKind: "http",
      },
    ]);
  });

  test("counts repeated control socket failures as socket recovery before observation and database checks", async () => {
    const timer = new FakeTimer();
    const databaseHealthProbe = new FakeDatabaseHealthProbe();
    const daemon = buildDaemon(timer, databaseHealthProbe);
    const internals = daemon as unknown as DaemonHealthInternals;
    cleanup = { internals, timer };
    const recoveryCalls: Array<{ at: number; failureKind?: string }> = [];
    let observationHealthChecks = 0;

    internals.httpServer = { listening: true };
    internals.socketServer = { isListening: () => false };
    internals.observationStreamHealth = {
      isHealthy: () => {
        observationHealthChecks += 1;
        return true;
      },
      recover: async () => {},
    };
    internals.attemptRecovery = async (failureKind) => {
      recoveryCalls.push({ at: timer.now(), failureKind });
    };

    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    }

    expect(observationHealthChecks).toBe(0);
    expect(databaseHealthProbe.checkCalls).toBe(0);
    expect(recoveryCalls).toEqual([
      {
        at: HEALTH_CHECK_INTERVAL_MS * MAX_FAILED_CHECKS,
        failureKind: "socket",
      },
    ]);
  });

  test("counts a missing observation stream socket as a socket health failure", async () => {
    const timer = new FakeTimer();
    const databaseHealthProbe = new FakeDatabaseHealthProbe();
    const daemon = buildDaemon(timer, databaseHealthProbe);
    const internals = daemon as unknown as DaemonHealthInternals;
    cleanup = { internals, timer };
    const recoveryCalls: Array<{ at: number; failureKind?: string }> = [];

    internals.httpServer = { listening: true };
    internals.socketServer = { isListening: () => true };
    internals.observationStreamHealth = {
      isHealthy: () => false,
      recover: async () => {},
    };
    internals.attemptRecovery = async (failureKind) => {
      recoveryCalls.push({ at: timer.now(), failureKind });
    };

    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    }

    expect(databaseHealthProbe.checkCalls).toBe(0);
    expect(recoveryCalls).toEqual([
      {
        at: HEALTH_CHECK_INTERVAL_MS * MAX_FAILED_CHECKS,
        failureKind: "socket",
      },
    ]);
  });

  test("recovers the observation stream socket on socket health recovery", async () => {
    const timer = new FakeTimer();
    const databaseHealthProbe = new FakeDatabaseHealthProbe();
    const daemon = buildDaemon(timer, databaseHealthProbe);
    const internals = daemon as unknown as DaemonHealthInternals;
    cleanup = { internals, timer };
    const recoverCalls: number[] = [];

    internals.observationStreamHealth = {
      isHealthy: () => false,
      recover: async () => {
        recoverCalls.push(timer.now());
      },
    };

    await internals.attemptRecovery("socket");

    expect(recoverCalls).toEqual([0]);
  });

  test("clears the health interval through the injected timer", () => {
    const timer = new FakeTimer();
    const databaseHealthProbe = new FakeDatabaseHealthProbe();
    const daemon = buildDaemon(timer, databaseHealthProbe);
    const internals = daemon as unknown as DaemonHealthInternals;
    cleanup = { internals, timer };
    const intervalCountBeforeHealthCheck = timer.getPendingIntervalCount();

    internals.startHealthCheckTimer();
    expect(timer.getPendingIntervalCount()).toBe(intervalCountBeforeHealthCheck + 1);

    internals.stopHealthCheckTimer();

    expect(timer.getPendingIntervalCount()).toBe(intervalCountBeforeHealthCheck);
    expect(internals.healthCheckTimer).toBe(null);
    cleanup = null;
  });
});
