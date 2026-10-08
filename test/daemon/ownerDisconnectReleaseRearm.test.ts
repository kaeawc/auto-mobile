import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS,
  OWNER_DISCONNECT_GRACE_MS,
  OWNER_DISCONNECT_RETRY_MAX_DELAY_MS,
  OWNER_DISCONNECTED_RELEASE_REASON,
  OwnerDisconnectExecutionVeto,
} from "../../src/daemon/ownerDisconnectRelease";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { ExecutionTracker } from "../../src/server/executionTracker";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";

// #10663: the owner-disconnect release was one-shot. The daemon vetoes it while the session has
// a call in flight (#5343), and the vetoed release was dropped, so the device then waited for
// the heartbeat path. A deferred release is now retried until the call settles, and a call that
// never settles keeps the session only up to the execution veto ceiling.

const DEVICE: BootedDevice = { name: "Pixel 8", platform: "android", deviceId: "emulator-5554" };
const OWNER_SESSION = "owner-session";
const OWNER_CONNECTION = "owner-connection";

describe("owner-disconnect release re-arm (#10663)", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let tracker: ExecutionTracker;
  let devicePool: DevicePool;
  let releaseReasons: string[];

  const settle = (ms: number) =>
    timer.advanceTimeAsync(ms, () => drainMicrotasks(FAKE_TIMER_QUIET_TURNS));

  const ownerSession = (): Session => {
    const session = sessionManager.getSession(OWNER_SESSION);
    if (!session) {
      throw new Error("owner session missing");
    }
    return session;
  };

  beforeEach(async () => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    tracker = new ExecutionTracker(timer, new FakeIdGenerator(["running-call"]));
    const hasActiveExecutions = (sessionId: string) =>
      tracker.hasActiveSessionUuidExecutions(sessionId);
    // As in the daemon: the same checker suppresses idle expiry and vetoes the release.
    sessionManager.setActiveSessionExecutionChecker(hasActiveExecutions);
    const veto = new OwnerDisconnectExecutionVeto(hasActiveExecutions, timer);
    releaseReasons = [];
    sessionManager.onSessionRelease((_sessionId, _deviceId, reason) => {
      releaseReasons.push(reason);
    });
    const deviceManager = new FakeDeviceManager();
    deviceManager.bootedDevices = [DEVICE];
    devicePool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "test-daemon-session-id", {
        timer,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceManager,
        retryExecutor: new DefaultRetryExecutor(timer),
        ownerDisconnect: {
          // Mirrors the daemon's port: defer while a call is in flight, else fenced release.
          release: async (session, reason) => {
            if (veto.keeps(session)) {
              return;
            }
            await releaseSessionAndDevice(
              sessionManager,
              devicePool,
              session.assignedDevice,
              session.sessionId,
              reason,
              {
                release: () =>
                  sessionManager.releaseSessionIfOwned(
                    session.sessionId,
                    session,
                    session.assignedDevice,
                    reason,
                  ),
              },
            );
          },
        },
      }),
    );
    await devicePool.initializeWithDevices([DEVICE]);
    await devicePool.bindOrReuseDeviceSession(
      OWNER_SESSION,
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
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  test("a release deferred by a running call fires soon after the call settles", async () => {
    const call = tracker.startExecution("tapOn", undefined, OWNER_SESSION);
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);

    await settle(OWNER_DISCONNECT_GRACE_MS + 10_000);
    expect(releaseReasons).toEqual([]);
    expect(sessionManager.getSession(OWNER_SESSION)).not.toBeNull();

    // Released within one retry delay of the call settling, without waiting for the heartbeat
    // monitor (which runs on the real daemon only, and only after the lease lapses).
    tracker.endExecution(call.id);
    await settle(OWNER_DISCONNECT_RETRY_MAX_DELAY_MS);

    expect(releaseReasons).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
    expect(devicePool.getDevice(DEVICE.deviceId)?.sessionId).toBeNull();
  });

  test("the call end restarting the idle window does not cancel the deferred release", async () => {
    // As in the daemon: a call's end restarts the session's idle window and activity clock.
    const unsubscribe = tracker.onSessionExecutionEnded((sessionUuids) => {
      for (const sessionUuid of sessionUuids) {
        sessionManager.recordToolCallEnded(sessionUuid);
      }
    });
    try {
      const call = tracker.startExecution("tapOn", undefined, OWNER_SESSION);
      devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);
      await settle(OWNER_DISCONNECT_GRACE_MS + 10_000);
      expect(releaseReasons).toEqual([]);

      tracker.endExecution(call.id);
      await settle(OWNER_DISCONNECT_RETRY_MAX_DELAY_MS);

      expect(releaseReasons).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
      expect(devicePool.getDevice(DEVICE.deviceId)?.sessionId).toBeNull();
    } finally {
      unsubscribe();
    }
  });

  test("an owner that reconnects while the release is deferred keeps its session", async () => {
    const call = tracker.startExecution("tapOn", undefined, OWNER_SESSION);
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);
    await settle(OWNER_DISCONNECT_GRACE_MS + 10_000);

    await devicePool.restoreOwnedDeviceSessionsForMcpSession([OWNER_SESSION], "reconnected");
    tracker.endExecution(call.id);
    await settle(OWNER_DISCONNECT_RETRY_MAX_DELAY_MS * 4);

    expect(releaseReasons).toEqual([]);
    expect(ownerSession().assignedDevice).toBe(DEVICE.deviceId);
    expect(devicePool["ownerDisconnectRelease"].isPending(OWNER_SESSION)).toBe(false);
  });

  test("a call that never settles keeps the session only up to the veto ceiling", async () => {
    tracker.startExecution("tapOn", undefined, OWNER_SESSION);
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);
    await settle(OWNER_DISCONNECT_GRACE_MS);

    await settle(OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS - OWNER_DISCONNECT_RETRY_MAX_DELAY_MS);
    expect(releaseReasons).toEqual([]);
    expect(sessionManager.getSession(OWNER_SESSION)).not.toBeNull();

    await settle(OWNER_DISCONNECT_RETRY_MAX_DELAY_MS * 2);

    expect(releaseReasons).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
    expect(devicePool.getDevice(DEVICE.deviceId)?.sessionId).toBeNull();
    // The hung call is still tracked: the release did not wait for it to settle.
    expect(tracker.hasActiveSessionUuidExecutions(OWNER_SESSION)).toBe(true);
  });
});

describe("OwnerDisconnectExecutionVeto (#10663)", () => {
  test("restarts its ceiling once the session has no active execution", () => {
    const timer = new FakeTimer();
    let active = true;
    const veto = new OwnerDisconnectExecutionVeto(() => active, timer, 1_000);
    const session = { sessionId: "s" } as Session;

    expect(veto.keeps(session)).toBe(true);
    timer.advanceTime(999);
    expect(veto.keeps(session)).toBe(true);

    active = false;
    expect(veto.keeps(session)).toBe(false);
    active = true;
    expect(veto.keeps(session)).toBe(true);
    timer.advanceTime(999);
    expect(veto.keeps(session)).toBe(true);
    timer.advanceTime(1);
    expect(veto.keeps(session)).toBe(false);
  });
});
