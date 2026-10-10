import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionHeartbeatMonitor } from "../../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { idleReleaseAt } from "../../../src/daemon/sessionHoldDiagnostics";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";

// Hunt (idle release, 2026-10-10): a one-shot CLI session's idle window is shifted by the daemon's
// own stall (#10835): `forgiveDaemonStall` moves `idleStallForgivenAt`, which the heartbeat monitor
// and `idleReleaseAt` read. It does not move `expiresAt`, and the admission of a NEW control call
// (`isSessionExpiredForNewExecution`) judges `expiresAt` without the `cli-idle` exemption
// `isSessionExpired` has. So the control call that should restart the forgiven window instead ends
// the session as `lazy-expiry`, before the instant the daemon itself reports as `idleReleaseAt`.

const SESSION = "cli-stall-session";
const DEVICE = "emulator-5554";
const CLI_IDLE_MS = 120_000;
const IDLE_BEFORE_STALL_MS = 90_000;
const STALL_MS = 40_000;

const drainMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

describe("a control call on a cli-idle session inside its stall-forgiven idle window", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let released: string[];
  let monitor: SessionHeartbeatMonitor;

  beforeEach(async () => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    released = [];
    sessionManager.onSessionRelease((_sessionId, _deviceId, reason) => {
      released.push(reason);
    });
    monitor = new SessionHeartbeatMonitor(
      sessionManager,
      () => false,
      async (sessionId, reason) => {
        await sessionManager.releaseSession(sessionId, reason);
      },
      timer,
    );
    await sessionManager.createSession(SESSION, DEVICE, "android", 60_000);
    expect(sessionManager.adoptCliLivenessPolicy(SESSION, CLI_IDLE_MS)).toBe(true);
    monitor.start();
    // 90 s idle with every scan on time, then the daemon's event loop is blocked for 40 s: both
    // clocks run, no timer fires. The session's unshifted deadline (120 s) falls inside the stall.
    await timer.advanceTimeAsync(IDLE_BEFORE_STALL_MS, drainMicrotasks);
    timer.setCurrentTime(timer.now() + STALL_MS);
  });

  afterEach(async () => {
    await monitor.stop();
    sessionManager.stopCleanupTimer();
  });

  const controlCallNow = () =>
    sessionManager
      .getOrCreateSession(SESSION, undefined, undefined, {
        executionId: "cli-call-after-stall",
        startTime: timer.now(),
      })
      .then(
        (session) => `admitted ${session.sessionId}`,
        (error: Error) => `${error.constructor.name}: ${error.message}`,
      );

  test("after the post-stall scan forgave the stall, the call is admitted before the reported idleReleaseAt", async () => {
    await monitor.tick();
    const session = sessionManager.getSession(SESSION)!;
    // The daemon's own answer for when this session is idle-released: 28 s from now.
    expect(idleReleaseAt(session)).toBeGreaterThan(timer.now());

    const outcome = await controlCallNow();
    await drainMicrotasks();

    expect(outcome).toBe(`admitted ${SESSION}`);
    expect(released).toEqual([]);
    expect(sessionManager.getSession(SESSION)).not.toBeNull();
  });

  test("the call arriving before the post-stall scan is admitted too (the stall probe forgives first)", async () => {
    const outcome = await controlCallNow();
    await drainMicrotasks();

    expect(outcome).toBe(`admitted ${SESSION}`);
    expect(released).toEqual([]);
  });
});
