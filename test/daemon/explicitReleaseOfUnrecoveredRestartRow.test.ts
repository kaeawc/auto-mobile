import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager, TerminalSessionError } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

// #11461 (restart ownership). An explicit release is terminal — the UUID ends with it, is never
// rehydrated, and a later call naming it is refused (docs/using/device-ownership.md, the reasons
// table). After a daemon restart a session whose row is still a recoverable handoff
// (`daemon-restart`) but which the new daemon has not recovered yet (the 15 s startup deadline left
// it to the follow-up sweep, or its recovery failed without terminalizing it) is in neither the
// session map nor the terminal fence. `daemon/releaseSession` used to answer such a UUID "already
// released" without recording anything, so the row stayed recoverable and the released session
// came back holding its device.

const SIM = "SIM-RESTART-ROW";
const SESSION = "5e550000-0000-4000-8000-00000000000a";
const ios = (deviceId: string): BootedDevice => ({ deviceId, name: deviceId, platform: "ios" });

describe("explicit release of a restart-recoverable session the daemon has not recovered yet", () => {
  let timer: FakeTimer;
  let persistence: FakeDeviceSessionPersistence;
  let sessions: SessionManager;
  let pool: DevicePool;
  let state: DaemonStateAccess;

  beforeEach(async () => {
    timer = new FakeTimer();
    persistence = new FakeDeviceSessionPersistence();
    // The previous daemon held SESSION on SIM; this daemon's startup marked the row daemon-restart.
    await persistence.upsertActiveSession({
      sessionUuid: SESSION,
      deviceId: SIM,
      stableDeviceId: SIM,
      platform: "ios",
      createdAtMs: 0,
      lastUsedAtMs: 0,
      expiresAtMs: 600_000,
      sessionTimeoutMs: 600_000,
      heartbeatTimeoutMs: 10_000,
      hasReceivedHeartbeat: true,
    });
    await persistence.markReleased(SESSION, "expired", 0, "daemon-restart");

    sessions = new SessionManager(timer, persistence);
    sessions.stopCleanupTimer();
    const manager = new FakeDeviceManager();
    manager.bootedDevices = [ios(SIM)];
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "explicit-release-unrecovered", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices([ios(SIM)]);
    state = {
      isInitialized: () => true,
      getSessionManager: () => sessions,
      getDevicePool: () => pool,
      getDeviceSessionRegistry: () => ({ list: () => [] }),
    };
  });

  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  const explicitRelease = () =>
    handleDaemonRequest(
      {
        id: "release",
        type: "daemon_request",
        method: "daemon/releaseSession",
        params: { sessionId: SESSION },
      },
      state,
    );

  test("the release is recorded, so a later call naming the UUID is refused as terminal", async () => {
    expect(await explicitRelease()).toMatchObject({ success: true });

    const rowReason = (await persistence.getSession?.(SESSION))?.release_reason;
    // A device tool call naming the released UUID (requireIssuedSession) must not re-issue it.
    const laterCall = await sessions
      .getOrCreateSession(SESSION, pool, undefined, undefined, true)
      .then(
        (session) => `re-issued on ${session.assignedDevice}`,
        (error: unknown) =>
          error instanceof TerminalSessionError ? "refused as terminal" : String(error),
      );

    // The owner released it: the row is no longer a recoverable handoff, and the UUID is fenced.
    expect({ rowReason, laterCall, holder: pool.getDevice(SIM)?.sessionId ?? null }).toEqual({
      rowReason: "explicit-release",
      laterCall: "refused as terminal",
      holder: null,
    });
  });

  test("the follow-up rehydration sweep does not bring the released session back", async () => {
    // The startup deadline passed with the row unstarted: it is left to the follow-up sweep.
    const summary = await sessions.rehydratePersistedSessions(pool, { deadlineMs: 0 });
    expect(summary.skipped).toEqual([{ sessionUuid: SESSION, reason: "startup-deadline" }]);

    // The owner releases its session before the sweep runs.
    expect(await explicitRelease()).toMatchObject({ success: true });

    await timer.advanceTimeAsync(0);
    await drainMicrotasks(50);

    expect(sessions.hasSession(SESSION)).toBe(false);
    expect(pool.getDevice(SIM)?.sessionId).toBeNull();
  });

  test("the device's restart-recovery reservation is given up with the release", async () => {
    await pool.reserveDevicesForRehydration([
      { sessionId: SESSION, target: { platform: "ios", stableDeviceId: SIM, deviceId: SIM } },
    ]);
    expect(pool.genericAvailability(SIM)).toBe("reserved");

    expect(await explicitRelease()).toMatchObject({ success: true });

    expect(pool.genericAvailability(SIM)).not.toBe("reserved");
  });

  test("a row another live daemon took is not this daemon's to terminalize", async () => {
    sessions.attachDaemonSessionId("this-daemon");
    sessions.attachLiveDaemonSessionIds(() => new Set(["this-daemon", "peer-daemon"]));
    const row = await persistence.getSession?.(SESSION);
    row!.daemon_session_id = "peer-daemon";

    expect(await explicitRelease()).toMatchObject({
      success: true,
      result: { alreadyReleased: true },
    });

    expect((await persistence.getSession?.(SESSION))?.release_reason).toBe("daemon-restart");
    expect(sessions.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
  });

  test("a repeated release answers already released", async () => {
    expect(await explicitRelease()).toMatchObject({
      success: true,
      result: { alreadyReleased: false, device: SIM },
    });
    expect(await explicitRelease()).toMatchObject({
      success: true,
      result: { alreadyReleased: true },
    });
  });
});
