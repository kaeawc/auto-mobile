import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import type { DevicePool } from "../../src/daemon/devicePool";
import { OWNER_DISCONNECT_GRACE_MS } from "../../src/daemon/ownerDisconnectRelease";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  SUSPECT_GRACE_MS,
} from "../../src/daemon/sessionLivenessWindows";
import { UNSETTLED_EXECUTION_DEADLINE_GRACE_MS } from "../../src/daemon/unsettledExecutionVeto";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import type { BootedDevice } from "../../src/models";
import { sessionReleasedDuringCallPayload } from "../../src/server/deviceSessionResult";
import { executionTracker, type ActiveExecution } from "../../src/server/executionTracker";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";

// #11381: every release that ends a session for a reason of its own cancels the calls it cuts
// with the typed release, so their callers get `session_ownership_lost` and not a generic abort.
// These drive the daemon's own wiring (the heartbeat reap and the owner-disconnect port built in
// daemon.ts) against the process execution tracker, rather than a copy of that wiring.

interface DaemonMonitorInternals {
  heartbeatMonitor: { stop(): Promise<void> } | null;
  startHeartbeatMonitor(): void;
}

const DEVICE: BootedDevice = {
  name: "Pixel_8_API_35",
  deviceId: "emulator-5554",
  platform: "android",
};
const SESSION = "typed-cancellation-session";
const OWNER_CONNECTION = "typed-cancellation-owner";

function stubPoolDiscovery(devicePool: DevicePool): void {
  const deviceManager = new FakeDeviceManager();
  deviceManager.bootedDevices = [DEVICE];
  Object.assign(devicePool, { deviceManager });
}

function expectTerminalRefusal(execution: ActiveExecution, reason: string): void {
  expect(execution.abortController.signal.aborted).toBe(true);
  expect(sessionReleasedDuringCallPayload(execution.cancelReason)).toMatchObject({
    error: {
      code: "session_ownership_lost",
      sessionUuid: SESSION,
      reason,
      retryable: false,
      nextAction: "acquire_new_session",
    },
  });
}

describe("Daemon session releases cancel in-flight calls with the typed release (#11381)", () => {
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
    // Only the release under test may end the session.
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

  const track = (execution: ActiveExecution): ActiveExecution => {
    started.push(execution);
    return execution;
  };

  test("the heartbeat monitor's reap answers the read it cuts with the terminal refusal", async () => {
    const sessionManager = daemon.getSessionManager();
    await sessionManager.createSession(
      SESSION,
      DEVICE.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      undefined,
      "awaiting-owner",
    );
    (daemon as unknown as DaemonMonitorInternals).startHeartbeatMonitor();
    // A read never keeps the session (#11322), so the reap lands while it is still running.
    const read = track(executionTracker.startExecution("observe", undefined, SESSION));
    executionTracker.markDeviceReadCall(read.id, read.toolName);

    await settle(
      DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS +
        SUSPECT_GRACE_MS +
        DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
    );

    expect(sessionManager.getSession(SESSION)).toBeNull();
    expectTerminalRefusal(read, "rehydration-owner-timeout");
  });

  /** A session on a pooled device, acquired by a connection that then closes. */
  async function ownedSessionWhoseOwnerDisconnects(
    beforeDisconnect?: () => void,
  ): Promise<DevicePool> {
    const devicePool = daemon.getDevicePool();
    stubPoolDiscovery(devicePool);
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
    beforeDisconnect?.();
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);
    return devicePool;
  }

  // The daemon builds the owner-disconnect veto while its pool is still being constructed; a veto
  // that captured the unset pool threw on every release, leaving the device to the heartbeat reap.
  test("the daemon's owner-disconnect release frees an idle session after the grace", async () => {
    const devicePool = await ownedSessionWhoseOwnerDisconnects();

    await settle(OWNER_DISCONNECT_GRACE_MS);

    expect(daemon.getSessionManager().getSession(SESSION)).toBeNull();
    expect(devicePool.getDevice(DEVICE.deviceId)?.sessionId).toBeNull();
  });

  test("the owner-disconnect release answers the call it cuts with the terminal refusal", async () => {
    // A call that never settles vetoes the release only until its deadline plus grace (#10712).
    const deadlineMs = timer.now() + OWNER_DISCONNECT_GRACE_MS + 1_000;
    let hungCall: ActiveExecution | undefined;
    const devicePool = await ownedSessionWhoseOwnerDisconnects(() => {
      hungCall = track(executionTracker.startExecution("tapOn", undefined, SESSION));
      executionTracker.setExecutionDeadline(hungCall.id, () => deadlineMs);
    });
    const hung = hungCall!;

    await settle(OWNER_DISCONNECT_GRACE_MS);
    expect(hung.abortController.signal.aborted).toBe(false);

    await settle(deadlineMs + UNSETTLED_EXECUTION_DEADLINE_GRACE_MS - timer.now());

    expect(devicePool.getDevice(DEVICE.deviceId)?.sessionId).toBeNull();
    expectTerminalRefusal(hung, "owner-disconnected");
  });

  // A call is told the session is gone only when the session IT runs under was released. A derived
  // `${base}:${label}` session expiring cuts the base session's call too (#10820), but the base
  // session is still live, so that call gets no refusal.
  describe("a derived label session's idle expiry", () => {
    const BASE = "typed-cancellation-base";
    const DERIVED = `${BASE}:A`;
    const LONG_TIMEOUT_MS = 60 * 60 * 1000;
    const DERIVED_TIMEOUT_MS = 1_000;

    async function baseWithDerivedLabel(): Promise<void> {
      const sessionManager = daemon.getSessionManager();
      await sessionManager.createSession(BASE, "emulator-5554", "android", LONG_TIMEOUT_MS);
      await sessionManager.createSession(DERIVED, "emulator-5556", "android", DERIVED_TIMEOUT_MS);
      sessionManager.setDeviceLabels(BASE, { A: DERIVED });
    }

    async function expireDerivedPastHungCall(execution: ActiveExecution): Promise<void> {
      const deadlineMs = timer.now() + 2_000;
      executionTracker.setExecutionDeadline(execution.id, () => deadlineMs);
      await settle(deadlineMs + UNSETTLED_EXECUTION_DEADLINE_GRACE_MS - timer.now() + 1);
      // The lookup that observes the expiry releases the session.
      expect(daemon.getSessionManager().getSession(DERIVED)).toBeNull();
    }

    test("cuts the base session's call without telling it the base session is gone", async () => {
      await baseWithDerivedLabel();
      const baseCall = track(executionTracker.startExecution("tapOn", undefined, BASE));

      await expireDerivedPastHungCall(baseCall);

      expect(baseCall.abortController.signal.aborted).toBe(true);
      expect(sessionReleasedDuringCallPayload(baseCall.cancelReason)).toBeUndefined();
      expect(daemon.getSessionManager().hasSession(BASE)).toBe(true);
    });

    test("answers the derived session's own call with the refusal naming the derived session", async () => {
      await baseWithDerivedLabel();
      const derivedCall = track(executionTracker.startExecution("tapOn", undefined, DERIVED));

      await expireDerivedPastHungCall(derivedCall);

      expect(derivedCall.abortController.signal.aborted).toBe(true);
      expect(sessionReleasedDuringCallPayload(derivedCall.cancelReason)).toMatchObject({
        error: { code: "session_ownership_lost", sessionUuid: DERIVED, reason: "lazy-expiry" },
      });
    });
  });
});
