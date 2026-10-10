import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS,
  OWNER_DISCONNECT_GRACE_MS,
  OWNER_DISCONNECTED_RELEASE_REASON,
  OwnerDisconnectExecutionVeto,
  OwnerDisconnectRelease,
} from "../../src/daemon/ownerDisconnectRelease";
import { UNSETTLED_EXECUTION_DEADLINE_GRACE_MS } from "../../src/daemon/unsettledExecutionVeto";
import { releaseSessionAndDevice } from "../../src/daemon/releaseSessionAndDevice";
import { SessionManager, type Session } from "../../src/daemon/sessionManager";
import { subscribeToolCallEndActivity } from "../../src/daemon/toolCallActivity";
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
// the heartbeat path. A deferred release is now retried when the call ends (#10712: re-armed by
// the execution-end event instead of polling), and a call that never settles keeps the session
// only up to its request deadline plus grace, or the veto ceiling when it has no deadline.

const DEVICE: BootedDevice = { name: "Pixel 8", platform: "android", deviceId: "emulator-5554" };
const OWNER_SESSION = "owner-session";
const OWNER_CONNECTION = "owner-connection";

describe("owner-disconnect release re-arm (#10663)", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let tracker: ExecutionTracker;
  let devicePool: DevicePool;
  let releaseReasons: string[];
  let unsubscribeExecutionEnded: () => void;

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
    const veto = new OwnerDisconnectExecutionVeto(
      {
        hasActiveExecutions,
        latestExecutionDeadlineMs: (sessionId) =>
          tracker.getLatestSessionExecutionDeadlineMs(sessionId),
      },
      timer,
    );
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
            const deferral = veto.keeps(session);
            if (deferral) {
              return deferral;
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
    // As in the daemon: an execution's end re-arms the releases it deferred.
    unsubscribeExecutionEnded = tracker.onSessionExecutionEnded((sessionUuids) =>
      devicePool.sessionExecutionsEnded(sessionUuids),
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
    unsubscribeExecutionEnded();
    sessionManager.stopCleanupTimer();
  });

  test("a release deferred by a running call fires soon after the call settles", async () => {
    const call = tracker.startExecution("tapOn", undefined, OWNER_SESSION);
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);

    await settle(OWNER_DISCONNECT_GRACE_MS + 10_000);
    expect(releaseReasons).toEqual([]);
    expect(sessionManager.getSession(OWNER_SESSION)).not.toBeNull();

    // Only the veto's bound is scheduled while the call runs: nothing polls (#10712).
    expect(timer.getPendingTimeouts()).toEqual([OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS]);

    // Released as soon as the call ends, without waiting for the heartbeat monitor (which runs
    // on the real daemon only, and only after the lease lapses).
    tracker.endExecution(call.id);
    await settle(0);

    expect(releaseReasons).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
    expect(devicePool.getDevice(DEVICE.deviceId)?.sessionId).toBeNull();
  });

  // #11381: an inventory read under the session vetoes the release like any call, but its end was
  // never reported, so the release it deferred waited for the veto's bound instead.
  test("a release deferred by an inventory read fires soon after the read ends", async () => {
    // The daemon's own subscription (daemon.ts subscribeToolCallEndActivity), not a copy of it.
    unsubscribeExecutionEnded();
    unsubscribeExecutionEnded = subscribeToolCallEndActivity(tracker, sessionManager, devicePool);
    const read = tracker.startExecution("listDevices", undefined, OWNER_SESSION);
    tracker.markReadOnlySessionAccess(read.id);
    tracker.markSessionAdmitted(read.id);
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);

    await settle(OWNER_DISCONNECT_GRACE_MS + 10_000);
    expect(releaseReasons).toEqual([]);
    const idleDeadline = ownerSession().expiresAt;

    tracker.endExecution(read.id);
    // The read's end is not use: it re-arms the release without restarting the idle window.
    expect(ownerSession().expiresAt).toBe(idleDeadline);
    await settle(0);

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
      await settle(0);

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
    await settle(20_000);

    expect(releaseReasons).toEqual([]);
    expect(ownerSession().assignedDevice).toBe(DEVICE.deviceId);
    expect(devicePool["ownerDisconnectRelease"].isPending(OWNER_SESSION)).toBe(false);
  });

  test("a call that never settles keeps the session only up to the veto ceiling", async () => {
    tracker.startExecution("tapOn", undefined, OWNER_SESSION);
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);
    await settle(OWNER_DISCONNECT_GRACE_MS);

    await settle(OWNER_DISCONNECT_EXECUTION_VETO_CEILING_MS - 1);
    expect(releaseReasons).toEqual([]);
    expect(sessionManager.getSession(OWNER_SESSION)).not.toBeNull();

    await settle(1);

    expect(releaseReasons).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
    expect(devicePool.getDevice(DEVICE.deviceId)?.sessionId).toBeNull();
    // The hung call is still tracked: the release did not wait for it to settle.
    expect(tracker.hasActiveSessionUuidExecutions(OWNER_SESSION)).toBe(true);
  });

  test("a call that never settles keeps the session only until its request deadline plus grace (#10712)", async () => {
    const call = tracker.startExecution("tapOn", undefined, OWNER_SESSION);
    const deadlineMs = OWNER_DISCONNECT_GRACE_MS + 60_000;
    tracker.setExecutionDeadline(call.id, () => deadlineMs);
    devicePool.releaseMcpSessionBindings(OWNER_CONNECTION);
    await settle(OWNER_DISCONNECT_GRACE_MS);

    await settle(deadlineMs + UNSETTLED_EXECUTION_DEADLINE_GRACE_MS - 1 - timer.now());
    expect(releaseReasons).toEqual([]);

    await settle(1);
    expect(releaseReasons).toEqual([OWNER_DISCONNECTED_RELEASE_REASON]);
    expect(tracker.hasActiveSessionUuidExecutions(OWNER_SESSION)).toBe(true);
  });
});

describe("OwnerDisconnectExecutionVeto (#10663)", () => {
  test("restarts its ceiling once the session has no active execution", () => {
    const timer = new FakeTimer();
    let active = true;
    const veto = new OwnerDisconnectExecutionVeto(() => active, timer, 1_000);
    const session = { sessionId: "s" } as Session;

    expect(veto.keeps(session)).toEqual({ deferredUntil: 1_000 });
    timer.advanceTime(999);
    expect(veto.keeps(session)).toEqual({ deferredUntil: 1_000 });

    active = false;
    expect(veto.keeps(session)).toBeUndefined();
    active = true;
    expect(veto.keeps(session)).toEqual({ deferredUntil: 1_999 });
    timer.advanceTime(999);
    expect(veto.keeps(session)).toBeDefined();
    timer.advanceTime(1);
    expect(veto.keeps(session)).toBeUndefined();
  });
});

describe("OwnerDisconnectRelease execution-end re-arm (#10712)", () => {
  test("a call that ends while a deferred attempt is in flight retries as soon as it settles", async () => {
    const timer = new FakeTimer();
    const session = {
      sessionId: "s",
      assignedDevice: "emulator-5554",
      livenessPolicy: "heartbeat",
      ownership: "owned",
    } as unknown as Session;
    const attempts: Array<(deferral?: { deferredUntil: number }) => void> = [];
    const release = new OwnerDisconnectRelease(
      {
        getSession: () => session,
        hasConnectedOwner: () => false,
        release: () => new Promise((resolve) => attempts.push(resolve)),
      },
      timer,
      1_000,
    );
    release.ownerDisconnected("s", "conn");
    // Still inside the disconnect grace: an execution end does not fire it early.
    release.executionsEnded(["s"]);
    await timer.advanceTimeAsync(999, () => drainMicrotasks(FAKE_TIMER_QUIET_TURNS));
    expect(attempts).toHaveLength(0);
    await timer.advanceTimeAsync(1, () => drainMicrotasks(FAKE_TIMER_QUIET_TURNS));
    expect(attempts).toHaveLength(1);

    attempts[0]!({ deferredUntil: 60_000 });
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
    expect(timer.getPendingTimeouts()).toEqual([59_000]);

    // The call ends while the retry attempt is in flight: the re-arm is not lost.
    release.executionsEnded(["s"]);
    await timer.advanceTimeAsync(0, () => drainMicrotasks(FAKE_TIMER_QUIET_TURNS));
    expect(attempts).toHaveLength(2);
    release.executionsEnded(["s"]);
    attempts[1]!({ deferredUntil: 60_000 });
    await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
    expect(timer.getPendingTimeouts()).toEqual([0]);
    await timer.advanceTimeAsync(0, () => drainMicrotasks(FAKE_TIMER_QUIET_TURNS));
    expect(attempts).toHaveLength(3);
  });
});
