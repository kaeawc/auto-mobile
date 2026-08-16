import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeDatabaseInitializer } from "../fakes/FakeDatabaseInitializer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeStartupFailureTracker } from "../fakes/FakeStartupFailureTracker";
import { FakeTimer } from "../fakes/FakeTimer";

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
  startHealthCheckTimer(): void;
  stopHealthCheckTimer(): void;
  attemptRecovery(failureKind?: string): Promise<void>;
}

class FakeDatabaseHealthProbe {
  checkCalls = 0;
  private error: Error | null = null;

  failWith(error: Error): void {
    this.error = error;
  }

  async check(): Promise<void> {
    this.checkCalls += 1;
    if (this.error) {
      throw this.error;
    }
  }
}

function buildDaemon(
  timer: FakeTimer,
  databaseHealthProbe: FakeDatabaseHealthProbe,
  exitProcess: (code: number) => Promise<void> | void = () => {}
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
    exitProcess
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
    internals.attemptRecovery = async failureKind => {
      recoveryCalls.push({ at: timer.now(), failureKind });
    };

    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    }

    expect(databaseHealthProbe.checkCalls).toBe(MAX_FAILED_CHECKS);
    expect(recoveryCalls).toEqual([{
      at: HEALTH_CHECK_INTERVAL_MS * MAX_FAILED_CHECKS,
      failureKind: "database",
    }]);
  });

  test("exits the daemon when repeated database probe failures reach recovery", async () => {
    const timer = new FakeTimer();
    const databaseHealthProbe = new FakeDatabaseHealthProbe();
    databaseHealthProbe.failWith(new Error("database disk image is malformed"));
    const exitCodes: number[] = [];
    const daemon = buildDaemon(timer, databaseHealthProbe, code => {
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

  test("awaits asynchronous database recovery before completing recovery", async () => {
    const timer = new FakeTimer();
    const databaseHealthProbe = new FakeDatabaseHealthProbe();
    const recoveryCodes: number[] = [];
    let finishRecovery!: () => void;
    const daemon = buildDaemon(timer, databaseHealthProbe, async code => {
      recoveryCodes.push(code);
      await new Promise<void>(resolve => {
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
    const daemon = buildDaemon(timer, databaseHealthProbe, code => {
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
    const daemon = buildDaemon(timer, databaseHealthProbe, code => {
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
    internals.attemptRecovery = async failureKind => {
      recoveryCalls.push({ at: timer.now(), failureKind });
    };

    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    }

    expect(observationHealthChecks).toBe(0);
    expect(databaseHealthProbe.checkCalls).toBe(0);
    expect(recoveryCalls).toEqual([{
      at: HEALTH_CHECK_INTERVAL_MS * MAX_FAILED_CHECKS,
      failureKind: "http",
    }]);
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
    internals.attemptRecovery = async failureKind => {
      recoveryCalls.push({ at: timer.now(), failureKind });
    };

    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    }

    expect(observationHealthChecks).toBe(0);
    expect(databaseHealthProbe.checkCalls).toBe(0);
    expect(recoveryCalls).toEqual([{
      at: HEALTH_CHECK_INTERVAL_MS * MAX_FAILED_CHECKS,
      failureKind: "socket",
    }]);
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
    internals.attemptRecovery = async failureKind => {
      recoveryCalls.push({ at: timer.now(), failureKind });
    };

    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    }

    expect(databaseHealthProbe.checkCalls).toBe(0);
    expect(recoveryCalls).toEqual([{
      at: HEALTH_CHECK_INTERVAL_MS * MAX_FAILED_CHECKS,
      failureKind: "socket",
    }]);
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
