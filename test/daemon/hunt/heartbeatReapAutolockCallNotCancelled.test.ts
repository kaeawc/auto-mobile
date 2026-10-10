import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../../src/daemon/daemon";
import { DaemonState } from "../../../src/daemon/daemonState";
import type { DevicePool } from "../../../src/daemon/devicePool";
import { DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS } from "../../../src/daemon/sessionLivenessWindows";
import { UNSETTLED_EXECUTION_DEADLINE_GRACE_MS } from "../../../src/daemon/unsettledExecutionVeto";
import { resetDbWriteBarrier } from "../../../src/db/dbWriteBarrier";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import type { BootedDevice } from "../../../src/models";
import { sessionReleasedDuringCallPayload } from "../../../src/server/deviceSessionResult";
import { executionTracker, type ActiveExecution } from "../../../src/server/executionTracker";
import { FakeDeviceManager } from "../../fakes/FakeDeviceManager";
import { FakeDeviceSessionRepository } from "../../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../../helpers/fakeTimerStepping";

// Hunt 2026-10-10. The heartbeat monitor's veto counts a session's implicit (autolock) calls as
// in flight, exactly as it counts calls that name the session UUID (`hasActiveSessionExecution`).
// Its release, however, cancels through `cancelAndReleaseSession`, which aborts only the calls
// indexed under the session UUID (`cancelSessionUuidExecutions`). A control call that reached the
// session through autolock and never settles therefore vetoes the release until its deadline plus
// grace, and is then left running when the session is released and its device freed: it is not
// aborted and its caller never gets `session_ownership_lost`. The idle-expiry release aborts the
// same call (`cancelDeviceSessionExecutions`, #10820).

interface DaemonMonitorInternals {
  heartbeatMonitor: { stop(): Promise<void> } | null;
  startHeartbeatMonitor(): void;
}

const DEVICE: BootedDevice = {
  name: "Pixel_8_API_35",
  deviceId: "emulator-5554",
  platform: "android",
};
const SESSION = "hunt-heartbeat-reap-autolock-session";
const OWNER_CONNECTION = "hunt-heartbeat-reap-owner-connection";
const CALL_DEADLINE_MS = 20_000;

describe("heartbeat reap of a session with an implicit (autolock) control call in flight", () => {
  let timer: FakeTimer;
  let daemon: Daemon;
  let started: ActiveExecution[];

  const settle = (ms: number) =>
    timer.advanceTimeAsync(ms, () => drainMicrotasks(FAKE_TIMER_QUIET_TURNS));

  beforeEach(() => {
    resetDbWriteBarrier();
    timer = new FakeTimer();
    daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      new FakeDeviceSessionRepository(),
    );
    daemon.getSessionManager().stopCleanupTimer();
    started = [];
  });

  afterEach(async () => {
    for (const execution of started) {
      executionTracker.endExecution(execution.id);
    }
    await (daemon as unknown as DaemonMonitorInternals).heartbeatMonitor?.stop();
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    NavigationGraphManager.resetInstance();
    resetDbWriteBarrier();
  });

  /** A session on a pooled device, acquired by a connection that stays open. */
  async function sessionOnPooledDevice(): Promise<DevicePool> {
    const devicePool = daemon.getDevicePool();
    const deviceManager = new FakeDeviceManager();
    deviceManager.bootedDevices = [DEVICE];
    Object.assign(devicePool, { deviceManager });
    await devicePool.initializeWithDevices([DEVICE]);
    await devicePool.bindOrReuseDeviceSession(
      SESSION,
      DEVICE.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      OWNER_CONNECTION,
    );
    return devicePool;
  }

  /**
   * An owned session whose owner heartbeated once and then went silent, with one admitted control
   * call that never settles and is driving the session's device.
   */
  async function reapPastHungCall(startCall: () => ActiveExecution): Promise<ActiveExecution> {
    const sessionManager = daemon.getSessionManager();
    const devicePool = await sessionOnPooledDevice();
    sessionManager.recordHeartbeat(SESSION);
    (daemon as unknown as DaemonMonitorInternals).startHeartbeatMonitor();

    const hung = startCall();
    started.push(hung);
    executionTracker.markSessionAdmitted(hung.id);
    executionTracker.markDeviceControlCall(hung.id);
    executionTracker.bindDeviceExecution(hung.id, DEVICE.deviceId);
    const deadlineMs = timer.now() + CALL_DEADLINE_MS;
    executionTracker.setExecutionDeadline(hung.id, () => deadlineMs);

    // Lease and grace are long over, but the control call still in flight keeps the session.
    await settle(deadlineMs - timer.now());
    expect(sessionManager.hasSession(SESSION)).toBe(true);
    expect(hung.abortController.signal.aborted).toBe(false);

    // Past the call's deadline plus grace the veto ends and the next scan releases the session
    // and frees its device for the next owner.
    await settle(
      UNSETTLED_EXECUTION_DEADLINE_GRACE_MS + DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
    );
    expect(sessionManager.hasSession(SESSION)).toBe(false);
    expect(devicePool.getDevice(DEVICE.deviceId)?.sessionId).toBeNull();
    return hung;
  }

  function expectCutWithTerminalRefusal(hung: ActiveExecution): void {
    expect(hung.abortController.signal.aborted).toBe(true);
    expect(sessionReleasedDuringCallPayload(hung.cancelReason)).toMatchObject({
      error: {
        code: "session_ownership_lost",
        sessionUuid: SESSION,
        reason: "heartbeat-timeout",
        retryable: false,
        nextAction: "acquire_new_session",
      },
    });
  }

  test("control: a hung call that names the session UUID is cut with the terminal refusal", async () => {
    const hung = await reapPastHungCall(() =>
      executionTracker.startExecution("tapOn", OWNER_CONNECTION, SESSION),
    );

    expectCutWithTerminalRefusal(hung);
  });

  test("a hung call that reached the session through autolock is cut with the terminal refusal", async () => {
    const hung = await reapPastHungCall(() => {
      const execution = executionTracker.startExecution("tapOn", OWNER_CONNECTION);
      executionTracker.setResolvedAutolockSessionUuid(execution.id, SESSION);
      return execution;
    });

    expectCutWithTerminalRefusal(hung);
  });
});
