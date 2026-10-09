import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { IncumbentOwnerGuard } from "../../src/daemon/incumbentOwnerGuard";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { setCtrlProxyForwardLeaseOwnerSocketPath } from "../../src/features/observe/shared/ctrlProxyForwardLeaseOwnership";
import { executionTracker } from "../../src/server/executionTracker";
import { logger } from "../../src/utils/logger";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// #10975: `start()` itself must subscribe the daemon to tool-call-end activity (owner decision
// 2026-10-08: the idle window counts from the END of a call). `daemonToolCallEndWiring.test.ts`
// calls the private subscription directly, so a `start()` that stopped calling it survived every
// test. This drives `start()` through its first steps and stops it at the first startup step
// that would touch the machine (the early owner record), with the real subscription in place.

interface DaemonStartInternals {
  setupShutdownHandlers(): void;
  writeEarlyOwnerRecord(): Promise<void>;
  stopSessionTimers(): void;
}

class StartupStopped extends Error {}

/** A guard whose refusal restore leaves the real PID file alone. */
class InertIncumbentGuard extends IncumbentOwnerGuard {
  override restoreIncumbentAfterRefusal(): boolean {
    return false;
  }
}

describe("Daemon.start() tool-call-end wiring", () => {
  const restores: Array<() => void> = [];
  let savedLaunchCwd: string | undefined;

  beforeEach(() => {
    savedLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];
  });

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) {
      restore();
    }
    if (savedLaunchCwd === undefined) {
      delete process.env[DAEMON_LAUNCH_CWD_ENV];
    } else {
      process.env[DAEMON_LAUNCH_CWD_ENV] = savedLaunchCwd;
    }
    setCtrlProxyForwardLeaseOwnerSocketPath(undefined);
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    NavigationGraphManager.resetInstance();
  });

  test("a started daemon stamps a session's activity at the end of its tool call", async () => {
    const timer = new FakeTimer();
    const daemon = new Daemon(
      {},
      undefined,
      timer,
      new DeviceSessionRepository(await createTestDatabase(), timer),
      new FakeIdGenerator(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new InertIncumbentGuard(),
    );
    const internals = daemon as unknown as DaemonStartInternals;
    for (const spy of [
      spyOn(process, "chdir").mockImplementation(() => {}),
      spyOn(logger, "enableStdoutLogging").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(internals, "setupShutdownHandlers").mockImplementation(() => {}),
      spyOn(internals, "writeEarlyOwnerRecord").mockRejectedValue(new StartupStopped()),
    ]) {
      restores.push(() => spy.mockRestore());
    }
    const sessionManager = daemon.getSessionManager();
    const session = await sessionManager.createSession("start-wiring", "emulator-5554", "android");

    try {
      await expect(daemon.start()).rejects.toBeInstanceOf(StartupStopped);

      // Held side: a call refused at admission is not use (#10824): its end moves nothing.
      const refused = executionTracker.startExecution("tapOn", undefined, "start-wiring");
      timer.advanceTime(30_000);
      executionTracker.endExecution(refused.id);
      expect(session.lastUsedAt).toBe(0);

      const execution = executionTracker.startExecution("tapOn", undefined, "start-wiring");
      executionTracker.markSessionAdmitted(execution.id);
      timer.advanceTime(60_000);
      executionTracker.endExecution(execution.id);

      // The end of the admitted call restarted the idle window from that moment.
      expect(session.lastUsedAt).toBe(90_000);
      expect(session.expiresAt).toBe(90_000 + session.sessionTimeoutMs);
    } finally {
      internals.stopSessionTimers();
    }
  });
});
