import { deliverDaemonHeartbeat } from "../helpers/daemonHeartbeatHandler";
import { makePool } from "../helpers/makePool";
import { afterEach, describe, expect, test } from "bun:test";
import { OWNER_DISCONNECT_GRACE_MS } from "../../src/daemon/ownerDisconnectRelease";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { PROXY_HEARTBEAT_INTERVAL_MS } from "../../src/daemon/wire/sessionLivenessWindows";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";

// #11162 item 1: the owner-disconnect release must not release a live owner whose reconnecting
// proxy's heartbeat is still buffered behind a daemon stall or host sleep that spans the grace.
// The release's `getSession` lookup runs the session source's stall probe before the blocker is
// judged, so a gap the owner was live for is forgiven first and moves the owner lease past the
// close; the blocker then leaves the session to its lease, which the buffered heartbeat renews.

const DEVICE: BootedDevice = { name: "Pixel 8", platform: "android", deviceId: "emulator-5554" };
const OWNER_SESSION = "owner-session";
const OWNER_CONNECTION = "owner-connection";
/** The owner's connection closes just before its next keeper heartbeat would have arrived. */
const CLOSE_AFTER_HEARTBEAT_MS = PROXY_HEARTBEAT_INTERVAL_MS - 100;
/** A gap that starts at the close and ends past the release's grace deadline. */
const GAP_MS = OWNER_DISCONNECT_GRACE_MS + 500;

interface Rig {
  timer: FakeTimer;
  sessionManager: SessionManager;
  monitor: SessionHeartbeatMonitor;
  releaseReasons: string[];
  /** Fire whatever is due now, as the event loop does on resume, before any socket data. */
  resume(): Promise<void>;
}

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.monitor.stop();
  rig?.sessionManager.stopCleanupTimer();
  rig = undefined;
});

async function setUp(checkIntervalMs?: number): Promise<Rig> {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000_000);
  const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const releaseReasons: string[] = [];
  sessionManager.onSessionRelease((_sessionId, _deviceId, reason) => releaseReasons.push(reason));
  const deviceManager = new FakeDeviceManager();
  deviceManager.bootedDevices = [DEVICE];
  const devicePool = makePool(sessionManager, "test-daemon-session-id", { timer, deviceManager });
  await devicePool.initializeWithDevices([DEVICE]);
  await devicePool.bindOrReuseDeviceSession({
    sessionId: OWNER_SESSION,
    deviceId: DEVICE.deviceId,
    platform: "android",
    allowSessionRebind: false,
    mcpSessionId: OWNER_CONNECTION,
  });
  await deliverDaemonHeartbeat(sessionManager, OWNER_SESSION);
  const monitor = new SessionHeartbeatMonitor(
    sessionManager,
    () => false,
    async (sessionId, reason) => {
      await sessionManager.releaseSession(sessionId, reason);
    },
    { timer, ...(checkIntervalMs === undefined ? {} : { checkIntervalMs }) },
  );
  monitor.start();
  timer.advanceTime(CLOSE_AFTER_HEARTBEAT_MS);
  devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);
  rig = {
    timer,
    sessionManager,
    monitor,
    releaseReasons,
    resume: async () => {
      await timer.advanceTimeAsync(0, () => drainMicrotasks(FAKE_TIMER_QUIET_TURNS));
      await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
    },
  };
  return rig;
}

function gap(r: Rig, kind: "stall" | "sleep"): void {
  if (kind === "stall") {
    // Nothing runs: the clocks move and every timer is overdue on resume.
    r.timer.setCurrentTime(r.timer.getCurrentTime() + GAP_MS);
  } else {
    r.timer.simulateHostSleep(GAP_MS);
  }
}

describe("owner-disconnect release across a daemon stall or host sleep (#11162)", () => {
  for (const kind of ["stall", "sleep"] as const) {
    test(`a ${kind} spanning the grace keeps a live owner whose buffered heartbeat is read on resume`, async () => {
      const r = await setUp();
      gap(r, kind);

      await r.resume();
      expect(r.releaseReasons).toEqual([]);
      await deliverDaemonHeartbeat(r.sessionManager, OWNER_SESSION);
      for (let tick = 0; tick < 6; tick++) {
        await r.timer.advanceTimeAsync(PROXY_HEARTBEAT_INTERVAL_MS, () =>
          drainMicrotasks(FAKE_TIMER_QUIET_TURNS),
        );
        await deliverDaemonHeartbeat(r.sessionManager, OWNER_SESSION);
      }

      expect(r.releaseReasons).toEqual([]);
      expect(r.sessionManager.getSession(OWNER_SESSION)).not.toBeNull();
    });

    test(`a ${kind} spanning the grace still releases an owner that never heartbeats again`, async () => {
      const r = await setUp();
      gap(r, kind);

      await r.resume();
      await r.timer.advanceTimeAsync(OWNER_DISCONNECT_GRACE_MS * 2, () =>
        drainMicrotasks(FAKE_TIMER_QUIET_TURNS),
      );

      expect(r.releaseReasons).toHaveLength(1);
      expect(r.sessionManager.getSession(OWNER_SESSION)).toBeNull();
    });
  }

  test("host sleep is forgiven before the release is judged even when the release timer fires before any scan", async () => {
    // A scan interval longer than the grace: on wake the release timer is the first due, so only
    // the stall probe its session lookup runs can account for the sleep.
    const r = await setUp(OWNER_DISCONNECT_GRACE_MS * 4);
    gap(r, "sleep");

    await r.resume();

    expect(r.releaseReasons).toEqual([]);
    expect(r.sessionManager.getSession(OWNER_SESSION)?.stallForgivenAt).toBeDefined();
  });
});
