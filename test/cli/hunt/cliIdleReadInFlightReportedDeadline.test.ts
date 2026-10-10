import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleSessionInfo } from "../../../src/daemon/daemonRequestHandlers";
import {
  SessionManager,
  type ActiveSessionExecutionQuery,
} from "../../../src/daemon/sessionManager";
import { SessionHeartbeatMonitor } from "../../../src/daemon/SessionHeartbeatMonitor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";

// A one-shot CLI session is released only by the heartbeat monitor, whose execution probe ignores
// reads (#11322, owner contract: a read never holds a session). `session-info` and the heartbeat
// ack report `idleReleaseAt` from the session manager's own veto lookup, which still counts a read
// in flight (#11381 item 2). For a `cli-idle` session the two surfaces then disagree: the monitor
// frees the device at the idle deadline while the daemon tells the CLI the release is due 30
// minutes later.

const SESSION = "00000000-0000-4000-8000-000000000044";
const DEVICE = "emulator-5554";
const CLI_IDLE_MS = 120_000;

const drain = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

describe("cli-idle session with a read in flight past its idle deadline", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let monitor: SessionHeartbeatMonitor;
  let reaped: Array<{ at: number; reason: string }>;
  let readInFlight: boolean;

  beforeEach(async () => {
    timer = new FakeTimer();
    readInFlight = false;
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    // The daemon's tracker: a read counts unless the caller excludes reads.
    manager.setActiveSessionExecutionChecker(
      (_sessionId: string, query?: ActiveSessionExecutionQuery) =>
        readInFlight && query?.excludeReads !== true,
    );
    reaped = [];
    monitor = new SessionHeartbeatMonitor(
      manager,
      // The monitor's probe is built with excludeReads: a read in flight is not seen.
      () => false,
      async (sessionId, reason) => {
        reaped.push({ at: timer.now(), reason });
        await manager.releaseSession(sessionId, reason);
      },
      timer,
    );
    await manager.createSession(SESSION, DEVICE, "android", 60_000);
    manager.adoptCliLivenessPolicy(SESSION, CLI_IDLE_MS);
    monitor.start();
  });

  afterEach(async () => {
    await monitor.stop();
    manager.stopCleanupTimer();
  });

  test("session-info does not report an idle release later than the monitor performs it", async () => {
    const lastToolActivityAt = manager.getSession(SESSION)!.lastUsedAt;
    readInFlight = true;

    await timer.advanceTimeAsync(CLI_IDLE_MS - 10_000, drain);
    const state = {
      getSessionManager: () => manager,
    } as unknown as Parameters<typeof handleSessionInfo>[1];
    const info = await handleSessionInfo(
      {
        id: "s1",
        type: "daemon_request",
        method: "daemon/sessionInfo",
        params: { sessionId: SESSION },
      },
      state,
      { getActiveDeviceSessionExecutionCount: () => 1 },
    );
    expect(info.success).toBe(true);
    const reportedIdleReleaseAt = (info as { result: { idleReleaseAt: number } }).result
      .idleReleaseAt;

    await timer.advanceTimeAsync(20_000, drain);

    // The monitor ignores the read: the session is gone at the idle deadline.
    expect(reaped.map((r) => r.reason)).toEqual(["cli-idle-timeout"]);
    // The daemon's own report must not promise a later release than the one it performs.
    expect(reportedIdleReleaseAt).toBeLessThanOrEqual(reaped[0].at);
    expect(reportedIdleReleaseAt).toBe(lastToolActivityAt + CLI_IDLE_MS);
  });
});
