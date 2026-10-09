import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { idleReleaseAt } from "../../src/daemon/sessionHoldDiagnostics";
import { DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS } from "../../src/daemon/sessionLivenessWindows";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #10835: a cli-idle session got no daemon-stall forgiveness, so after the daemon's own event loop
// stalled, whether the session survived depended on which timer ran first: a queued CLI call kept
// it, the post-stall scan released it. Heartbeat-policy sessions were already shifted by the lost
// interval (#10661, #10662). The stall now shifts the cli-idle window the same way, while host
// sleep still counts toward idle.

const SESSION = "cli-stall-session";
const DEVICE = "emulator-5554";
const CLI_IDLE_MS = 120_000;
const SCAN_MS = DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;
const IDLE_BEFORE_STALL_MS = 90_000;
const STALL_MS = 40_000;

const drainMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

describe("cli-idle session across a daemon stall (#10835)", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let reaped: string[];
  let monitor: SessionHeartbeatMonitor;

  beforeEach(async () => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    reaped = [];
    monitor = new SessionHeartbeatMonitor(
      sessionManager,
      () => false,
      async (sessionId, reason) => {
        reaped.push(reason);
        await sessionManager.releaseSession(sessionId, reason);
      },
      timer,
    );
    await sessionManager.createSession(SESSION, DEVICE, "android", 60_000);
    expect(sessionManager.adoptCliLivenessPolicy(SESSION, CLI_IDLE_MS)).toBe(true);
    monitor.start();
    // Idle, with every scan on time.
    await timer.advanceTimeAsync(IDLE_BEFORE_STALL_MS, drainMicrotasks);
    expect(reaped).toEqual([]);
  });

  afterEach(async () => {
    await monitor.stop();
    sessionManager.stopCleanupTimer();
  });

  test("the post-stall scan running first keeps the session", async () => {
    // The daemon's event loop is blocked: both clocks run, no timer fires.
    timer.setCurrentTime(timer.now() + STALL_MS);

    await monitor.tick();

    expect(reaped).toEqual([]);
    expect(sessionManager.getSession(SESSION)).not.toBeNull();
  });

  test("the stall leaves the tool-activity clock alone and moves only the idle anchor", async () => {
    const session = sessionManager.getSession(SESSION)!;
    const lastUsedAt = session.lastUsedAt;
    timer.setCurrentTime(timer.now() + STALL_MS);

    await monitor.tick();

    expect(session.lastUsedAt).toBe(lastUsedAt);
    // Forgiven by the lateness: the gap minus the one scan interval that was due anyway.
    const lostMs = STALL_MS - SCAN_MS;
    expect(session.idleStallForgivenAt).toBe(lastUsedAt + lostMs);
    expect(idleReleaseAt(session)).toBe(lastUsedAt + lostMs + CLI_IDLE_MS);
  });

  test("the forgiven window still ends: true idleness after the stall releases the session", async () => {
    timer.setCurrentTime(timer.now() + STALL_MS);
    await monitor.tick();

    // About 30s of the 120s window remain once the stall is forgiven.
    await timer.advanceTimeAsync(CLI_IDLE_MS - IDLE_BEFORE_STALL_MS - SCAN_MS * 2, drainMicrotasks);
    expect(reaped).toEqual([]);
    await timer.advanceTimeAsync(SCAN_MS * 3, drainMicrotasks);

    expect(reaped).toEqual(["cli-idle-timeout"]);
  });

  test("a tool call after the stall restarts the window from the call, superseding the anchor", async () => {
    const session = sessionManager.getSession(SESSION)!;
    timer.setCurrentTime(timer.now() + STALL_MS);
    await monitor.tick();

    sessionManager.recordToolCallEnded(SESSION);

    expect(idleReleaseAt(session)).toBe(timer.now() + CLI_IDLE_MS);
  });

  test("host sleep of the same length still counts toward idle", async () => {
    timer.simulateHostSleep(STALL_MS);

    await monitor.tick();

    expect(reaped).toEqual(["cli-idle-timeout"]);
  });
});
