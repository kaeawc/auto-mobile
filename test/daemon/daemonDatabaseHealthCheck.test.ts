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

interface DaemonHealthInternals {
  httpServer: { listening: boolean } | null;
  socketServer: FakeSocketServer | null;
  healthCheckTimer: NodeJS.Timeout | null;
  startHealthCheckTimer(): void;
  attemptRecovery(): Promise<void>;
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

function buildDaemon(timer: FakeTimer, databaseHealthProbe: FakeDatabaseHealthProbe): Daemon {
  return new Daemon(
    {},
    new FakeInstalledAppsRepository(),
    timer,
    undefined,
    new CountingIdGenerator("daemon-session"),
    new FakeDatabaseInitializer(),
    new FakeStartupFailureTracker(),
    databaseHealthProbe
  );
}

describe("Daemon database health check", () => {
  let internalsToCleanUp: DaemonHealthInternals | null = null;

  afterEach(() => {
    if (internalsToCleanUp?.healthCheckTimer) {
      clearInterval(internalsToCleanUp.healthCheckTimer);
      internalsToCleanUp = null;
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
    internalsToCleanUp = internals;
    const recoveryTimes: number[] = [];

    internals.httpServer = { listening: true };
    internals.socketServer = { isListening: () => true };
    internals.attemptRecovery = async () => {
      recoveryTimes.push(timer.now());
    };

    internals.startHealthCheckTimer();

    for (let i = 0; i < MAX_FAILED_CHECKS; i += 1) {
      await timer.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS);
    }

    expect(databaseHealthProbe.checkCalls).toBe(MAX_FAILED_CHECKS);
    expect(recoveryTimes).toEqual([HEALTH_CHECK_INTERVAL_MS * MAX_FAILED_CHECKS]);
  });
});
