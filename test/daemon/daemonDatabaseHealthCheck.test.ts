import {
  AuxiliarySocketBindConflict,
  degradeAuxiliarySocket,
  markAuxiliarySocketAvailable,
} from "../../src/daemon/auxiliarySocketAvailability";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeDatabaseInitializer } from "../fakes/FakeDatabaseInitializer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeStartupFailureTracker } from "../fakes/FakeStartupFailureTracker";
import { FakeHttpServer } from "../fakes/FakeHttpServer";
import { FakeTimer } from "../fakes/FakeTimer";

import { logger } from "../../src/utils/logger";

import { DatabaseHealthProbeTimeoutError } from "../../src/db/DatabaseHealthProbeTimeoutError";

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const MAX_FAILED_CHECKS = 3;

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
    {
      installedAppsRepository: new FakeInstalledAppsRepository(),
      timer,
      idGenerator: new CountingIdGenerator("daemon-session"),
      databaseInitializer: new FakeDatabaseInitializer(),
      startupFailureTracker: new FakeStartupFailureTracker(),
      databaseHealthProbe,
      recoverFromDatabaseHealthFailure: exitProcess,
      // The real answer comes from the process-wide log sink, which a starved event loop in an
      // unrelated file can flag as stalled and so excuse every timeout this file counts (#15279).
      hostIoStalled: () => false,
    },
  );
  daemon.testHooks.setObservationStreamHealth({
    isHealthy: () => true,
    recover: async () => {},
  });
  return daemon;
}

async function flushMicrotasks(): Promise<void> {
  // A tick now ends only after its in-flight promise settles, so drain enough
  // microtask turns for the whole async chain, not just the first await.
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

async function advanceOneInterval(timer: FakeTimer): Promise<void> {
  await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
  await flushMicrotasks();
}

describe("Daemon database health check", () => {
  let cleanup: { internals: Daemon["testHooks"]; timer: FakeTimer } | null = null;

  afterEach(() => {
    markAuxiliarySocketAvailable("observation-stream");
    const healthCheck = cleanup?.internals.healthCheck();
    if (healthCheck) {
      void healthCheck.stop();
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
    const internals = daemon.testHooks;
    cleanup = { internals, timer };
    internals.httpIngress.setHttpServer(new FakeHttpServer(true));
    internals.setSocketServer({ isListening: () => true });
    internals.startHealthCheckTimer();
    // Move past the schedule before firing; async advance preserves the late reading.
    const tick = async (lateMs = 0) => {
      timer.setCurrentTime(timer.now() + HEALTH_CHECK_INTERVAL_MS + lateMs);
      await timer.advanceTimeAsync(0, flushMicrotasks);
    };
    return { timer, probe, exits, internals, tick };
  }

  test("degraded observation stream still probes the wedged DB and triggers self-exit", async () => {
    const h = timeoutHarness();
    h.internals.setObservationStreamHealth({ isHealthy: () => false, recover: async () => {} });
    degradeAuxiliarySocket(
      "observation-stream",
      new AuxiliarySocketBindConflict("/fake/stream.sock", "Stream"),
    );
    for (let i = 0; i < 3; i++) {
      await h.tick();
    }
    expect(h.probe.checkCalls).toBe(3);
    expect(h.exits).toEqual([{ code: 1, detail: "Database health probe timed out after 1000ms" }]);
  });

  test("degraded observation retries keep healthy servers running and probe the DB every tick", async () => {
    const timer = new FakeTimer();
    const probe = new FakeDatabaseHealthProbe();
    const exits: number[] = [];
    const daemon = buildDaemon(timer, probe, (code) => {
      exits.push(code);
    });
    const internals = daemon.testHooks;
    cleanup = { internals, timer };
    internals.httpIngress.setHttpServer(new FakeHttpServer(true));
    let controlCloses = 0;
    internals.setSocketServer({
      isListening: () => true,
      close: async () => {
        controlCloses++;
      },
    });
    let retries = 0;
    const conflict = new AuxiliarySocketBindConflict("/fake/stream.sock", "Stream");
    degradeAuxiliarySocket("observation-stream", conflict);
    internals.setObservationStreamHealth({
      isHealthy: () => false,
      recover: async () => {
        retries++;
        throw conflict;
      },
    });
    let fullRecoveries = 0;
    internals.overrideAttemptRecovery(async () => {
      fullRecoveries++;
    });
    const stop = spyOn(daemon, "stop").mockResolvedValue();
    try {
      internals.startHealthCheckTimer();
      for (let i = 0; i < 5; i++) {
        await advanceOneInterval(timer);
      }
      expect(probe.checkCalls).toBe(5);
      expect(retries).toBe(5);
      expect(fullRecoveries).toBe(0);
      expect(controlCloses).toBe(0);
      expect(exits).toEqual([]);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      stop.mockRestore();
    }
  });

  test("recovery reports an observation stream that remains degraded accurately", async () => {
    const h = timeoutHarness();
    h.internals.setObservationStreamHealth({ isHealthy: () => false, recover: async () => {} });
    degradeAuxiliarySocket(
      "observation-stream",
      new AuxiliarySocketBindConflict("/fake/stream.sock", "Stream"),
    );
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await h.internals.attemptRecovery("socket");
      expect(warn).toHaveBeenCalledWith(
        "Observation stream socket server remains unavailable after recovery",
      );
      expect(info).not.toHaveBeenCalledWith(
        "Observation stream socket server restarted successfully",
      );
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

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
    expect(h.internals.lastDatabaseHealthFailure()).toBe(
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
    const internals = daemon.testHooks;
    cleanup = { internals, timer };
    const recoveryCalls: Array<{ at: number; failureKind?: string }> = [];

    internals.httpIngress.setHttpServer(new FakeHttpServer(true));
    internals.setSocketServer({ isListening: () => true });
    internals.overrideAttemptRecovery(async (failureKind) => {
      recoveryCalls.push({ at: timer.now(), failureKind });
    });

    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await advanceOneInterval(timer);
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
    const internals = daemon.testHooks;
    cleanup = { internals, timer };

    internals.httpIngress.setHttpServer(new FakeHttpServer(true));
    internals.setSocketServer({ isListening: () => true });
    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await advanceOneInterval(timer);
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
    const internals = daemon.testHooks;
    cleanup = { internals, timer };

    internals.httpIngress.setHttpServer(new FakeHttpServer(true));
    internals.setSocketServer({ isListening: () => true });
    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await advanceOneInterval(timer);
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
    const internals = daemon.testHooks;
    cleanup = { internals, timer };

    internals.httpIngress.setHttpServer(new FakeHttpServer(true));
    internals.setSocketServer({ isListening: () => true });
    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS - 1; i += 1) {
      await advanceOneInterval(timer);
    }

    databaseHealthProbe.succeed();
    await advanceOneInterval(timer);

    databaseHealthProbe.failWith(new Error("second failure"));
    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await advanceOneInterval(timer);
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
    const internals = daemon.testHooks;

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
    const internals = daemon.testHooks;
    cleanup = { internals, timer };

    internals.httpIngress.setHttpServer(new FakeHttpServer(false));
    internals.setSocketServer({ isListening: () => true });
    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS - 1; i += 1) {
      await advanceOneInterval(timer);
    }

    internals.httpIngress.setHttpServer(new FakeHttpServer(true));
    await advanceOneInterval(timer);

    expect(databaseHealthProbe.checkCalls).toBe(1);
    expect(exitCodes).toEqual([]);

    for (let i = 0; i < MAX_FAILED_CHECKS - 1; i += 1) {
      await advanceOneInterval(timer);
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
    const internals = daemon.testHooks;
    cleanup = { internals, timer };

    internals.httpIngress.setHttpServer(new FakeHttpServer(false));
    internals.setSocketServer({ isListening: () => true });
    internals.startHealthCheckTimer();

    await advanceOneInterval(timer);

    internals.httpIngress.setHttpServer(new FakeHttpServer(true));
    internals.setSocketServer({ isListening: () => false });
    await advanceOneInterval(timer);

    internals.setSocketServer({ isListening: () => true });
    await advanceOneInterval(timer);

    expect(databaseHealthProbe.checkCalls).toBe(1);
    expect(exitCodes).toEqual([]);

    for (let i = 0; i < MAX_FAILED_CHECKS - 1; i += 1) {
      await advanceOneInterval(timer);
    }

    expect(databaseHealthProbe.checkCalls).toBe(MAX_FAILED_CHECKS);
    expect(exitCodes).toEqual([1]);
  });

  test("counts repeated HTTP failures as HTTP recovery without probing socket or database health", async () => {
    const timer = new FakeTimer();
    const databaseHealthProbe = new FakeDatabaseHealthProbe();
    const daemon = buildDaemon(timer, databaseHealthProbe);
    const internals = daemon.testHooks;
    cleanup = { internals, timer };
    const recoveryCalls: Array<{ at: number; failureKind?: string }> = [];
    let observationHealthChecks = 0;

    internals.httpIngress.setHttpServer(new FakeHttpServer(false));
    internals.setSocketServer({ isListening: () => true });
    internals.setObservationStreamHealth({
      isHealthy: () => {
        observationHealthChecks += 1;
        return true;
      },
      recover: async () => {},
    });
    internals.overrideAttemptRecovery(async (failureKind) => {
      recoveryCalls.push({ at: timer.now(), failureKind });
    });

    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await advanceOneInterval(timer);
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
    const internals = daemon.testHooks;
    cleanup = { internals, timer };
    const recoveryCalls: Array<{ at: number; failureKind?: string }> = [];
    let observationHealthChecks = 0;

    internals.httpIngress.setHttpServer(new FakeHttpServer(true));
    internals.setSocketServer({ isListening: () => false });
    internals.setObservationStreamHealth({
      isHealthy: () => {
        observationHealthChecks += 1;
        return true;
      },
      recover: async () => {},
    });
    internals.overrideAttemptRecovery(async (failureKind) => {
      recoveryCalls.push({ at: timer.now(), failureKind });
    });

    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await advanceOneInterval(timer);
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
    const internals = daemon.testHooks;
    cleanup = { internals, timer };
    const recoveryCalls: Array<{ at: number; failureKind?: string }> = [];

    internals.httpIngress.setHttpServer(new FakeHttpServer(true));
    internals.setSocketServer({ isListening: () => true });
    internals.setObservationStreamHealth({
      isHealthy: () => false,
      recover: async () => {},
    });
    internals.overrideAttemptRecovery(async (failureKind) => {
      recoveryCalls.push({ at: timer.now(), failureKind });
    });

    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await advanceOneInterval(timer);
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
    const internals = daemon.testHooks;
    cleanup = { internals, timer };
    const recoverCalls: number[] = [];

    internals.setObservationStreamHealth({
      isHealthy: () => false,
      recover: async () => {
        recoverCalls.push(timer.now());
      },
    });

    await internals.attemptRecovery("socket");

    expect(recoverCalls).toEqual([0]);
  });

  test("clears the health interval through the injected timer", async () => {
    const timer = new FakeTimer();
    const databaseHealthProbe = new FakeDatabaseHealthProbe();
    const daemon = buildDaemon(timer, databaseHealthProbe);
    const internals = daemon.testHooks;
    cleanup = { internals, timer };
    const intervalCountBeforeHealthCheck = timer.getPendingIntervalCount();

    internals.startHealthCheckTimer();
    expect(timer.getPendingIntervalCount()).toBe(intervalCountBeforeHealthCheck + 1);

    await internals.stopHealthCheckTimer();

    expect(timer.getPendingIntervalCount()).toBe(intervalCountBeforeHealthCheck);
    expect(internals.healthCheck()).toBe(null);
    cleanup = null;
  });
});
